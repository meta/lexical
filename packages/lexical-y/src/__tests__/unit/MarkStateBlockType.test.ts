/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Turning a commented list item into another block with $setBlocksType keeps
// its comment ids (MarkStateExtension) in the editor that converts it, in the
// document it writes, and in an editor that loads that document.
// @vitest-environment node

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  ListExtension,
} from '@lexical/list';
import {$addMarkID, $getNodeMarkIDs, MarkStateExtension} from '@lexical/mark';
import {
  $createHeadingNode,
  $createQuoteNode,
  RichTextExtension,
} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  configExtension,
  defineExtension,
  type ElementNode,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YCollabExtension, type YDoc} from '../..';

function buildEditor(doc: YDoc) {
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        RichTextExtension,
        ListExtension,
        MarkStateExtension,
        configExtension(YCollabExtension, {
          doc,
          schemaVersion: 1,
          selfCheck: true,
        }),
      ],
      name: '@lexical/y/test/mark-state-block-type',
      onError: (e: Error) => {
        throw e;
      },
    }),
  );
  const {binding} = getExtensionDependencyFromEditor(
    editor,
    YCollabExtension,
  ).output;
  return {binding, editor};
}

function marks(editor: LexicalEditor): string {
  return editor.read(() =>
    $getRoot()
      .getChildren()
      .map(
        block =>
          `${block.getType()}(${($isElementNode(block)
            ? block.getAllTextNodes()
            : []
          )
            .map(
              text =>
                JSON.stringify(text.getTextContent()) +
                JSON.stringify($getNodeMarkIDs(text)),
            )
            .join(' ')})`,
      )
      .join(' '),
  );
}

const TARGETS: [string, () => ElementNode][] = [
  ['paragraph', () => $createParagraphNode()],
  ['quote', () => $createQuoteNode()],
  ['heading', () => $createHeadingNode('h2')],
];

describe('MarkStateExtension with @lexical/y', () => {
  test.each(TARGETS)(
    'a list item with a comment turned into a %s keeps the comment',
    async (type, $createBlock) => {
      const doc = createYDoc();
      const {binding, editor} = buildEditor(doc);
      editor.update(
        () => {
          const text = $createTextNode('alpha beta');
          $getRoot()
            .clear()
            .append(
              $createListNode('bullet').append(
                $createListItemNode().append(text),
              ),
            );
          $addMarkID('c1', text.select(6, 10));
        },
        {discrete: true},
      );
      binding.initialize();
      expect(marks(editor)).toBe('list("alpha "[] "beta"["c1"])');
      editor.update(
        () => {
          $getRoot().getAllTextNodes().at(-1)!.selectEnd();
          $setBlocksType($getSelection(), $createBlock);
        },
        {discrete: true},
      );
      const expected = `${type}("alpha "[] "beta"["c1"])`;
      expect(marks(editor)).toBe(expected);

      const loaded = createYDoc(Y.encodeStateAsUpdate(doc));
      const reader = buildEditor(loaded);
      reader.binding.initialize();
      await Promise.resolve();
      expect(marks(reader.editor)).toBe(expected);
    },
  );
});
