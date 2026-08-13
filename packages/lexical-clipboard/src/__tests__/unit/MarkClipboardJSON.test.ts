/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $generateJSONFromSelectedNodes,
  $generateNodesFromSerializedNodes,
} from '@lexical/clipboard';
import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {$createMarkNode, $isMarkNode, MarkNode} from '@lexical/mark';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $selectAll,
  type LexicalNode,
} from 'lexical';
import {assert, describe, expect, it} from 'vitest';

// MarkNode.excludeFromCopy() is `destination !== 'clone'` — keep me in the
// internal clone payload, drop me from HTML. $appendNodesToJSON builds the
// `application/x-lexical-editor` clone payload but asked with 'html', so marks
// were stripped from it.

const extension = defineExtension({
  $initialEditorState: () => {
    $getRoot()
      .clear()
      .append(
        $createParagraphNode().append(
          $createMarkNode(['comment-1']).append($createTextNode('marked')),
        ),
      );
  },
  dependencies: [RichTextExtension],
  name: '[mark-clipboard]',
  nodes: [MarkNode],
});

function hasMark(nodes: LexicalNode[]): boolean {
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.shift()!;
    if ($isMarkNode(node)) {
      return true;
    }
    if ($isElementNode(node)) {
      stack.unshift(...node.getChildren());
    }
  }
  return false;
}

describe('$generateJSONFromSelectedNodes with a MarkNode', () => {
  it('keeps the MarkNode in the clone payload', () => {
    using editor = buildEditorFromExtensions(extension);

    editor.update(
      () => {
        $selectAll();
        const {nodes} = $generateJSONFromSelectedNodes(editor, $getSelection());
        const rebuilt = $generateNodesFromSerializedNodes(nodes);

        expect(hasMark(rebuilt)).toBe(true);
      },
      {discrete: true},
    );
  });

  it('keeps the mark ids on the round trip', () => {
    using editor = buildEditorFromExtensions(extension);

    editor.update(
      () => {
        $selectAll();
        const {nodes} = $generateJSONFromSelectedNodes(editor, $getSelection());
        const rebuilt = $generateNodesFromSerializedNodes(nodes);

        const stack = [...rebuilt];
        let ids: string[] | null = null;
        while (stack.length > 0) {
          const node = stack.shift()!;
          if ($isMarkNode(node)) {
            ids = node.getIDs();
            break;
          }
          if ($isElementNode(node)) {
            stack.unshift(...node.getChildren());
          }
        }
        assert(ids !== null, 'expected a MarkNode');
        expect(ids).toEqual(['comment-1']);
      },
      {discrete: true},
    );
  });

  it('still carries the marked text', () => {
    using editor = buildEditorFromExtensions(extension);

    editor.update(
      () => {
        $selectAll();
        const {nodes} = $generateJSONFromSelectedNodes(editor, $getSelection());
        const rebuilt = $generateNodesFromSerializedNodes(nodes);

        expect(rebuilt.map(node => node.getTextContent()).join('')).toContain(
          'marked',
        );
      },
      {discrete: true},
    );
  });
});
