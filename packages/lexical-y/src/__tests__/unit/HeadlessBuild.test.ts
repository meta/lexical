/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Content built in a headless editor bound to a new document (as a server
// seeds one), in an update that runs Lexical's transforms: the binding's
// normalization runs on it, so a list item holding text beside a nested
// list is written with the nested list in an item of its own, and a read of
// the document shows what the editor shows.

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  configExtension,
  defineExtension,
  type LexicalNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YCollabExtension, type YDoc} from '../..';

function headless(doc: YDoc) {
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        configExtension(YCollabExtension, {
          doc,
          schemaVersion: 1,
          selfCheck: true,
        }),
      ],
      name: '@lexical/y/test/headless-build',
      nodes: [ListNode, ListItemNode],
      onError: e => {
        throw e;
      },
    }),
  );
  const binding = getExtensionDependencyFromEditor(editor, YCollabExtension)
    .output.binding;
  return {binding, editor};
}

/** List items holding text and a list side by side. */
function mixedItems(editor: ReturnType<typeof headless>['editor']): number {
  return editor.getEditorState().read(() => {
    let n = 0;
    const walk = (node: LexicalNode) => {
      if ($isListItemNode(node)) {
        const kids = node.getChildren();
        if (kids.some($isListNode) && kids.some(k => !$isListNode(k))) {
          n++;
        }
      }
      if ($isElementNode(node)) {
        node.getChildren().forEach(walk);
      }
    };
    walk($getRoot());
    return n;
  });
}

const $build = () => {
  $getRoot().append(
    $createParagraphNode().append($createTextNode('title')),
    $createListNode('bullet').append(
      $createListItemNode().append($createTextNode('one')),
      // Text beside a nested list, in one item.
      $createListItemNode().append(
        $createTextNode('two'),
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('nested')),
        ),
      ),
    ),
  );
};

for (const when of ['before initialize', 'after initialize']) {
  test(`content built with transforms ${when}: written normalized, and a read shows what the editor shows`, async () => {
    const doc = createYDoc();
    const {binding, editor} = headless(doc);
    if (when === 'before initialize') {
      editor.update($build);
      binding.initialize();
    } else {
      binding.initialize();
      editor.update($build, {discrete: true});
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mixedItems(editor)).toBe(0);
    const copy = createYDoc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    const reader = headless(copy);
    reader.binding.initialize();
    expect(mixedItems(reader.editor)).toBe(0);
    expect(reader.editor.getEditorState().toJSON()).toEqual(
      editor.getEditorState().toJSON(),
    );
    editor.dispose();
    reader.editor.dispose();
  });
}
