/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createCodeHighlightNode,
  $createCodeNode,
  $isCodeNode,
  registerCodeGutter,
} from '@lexical/code-core';
import {
  $createLineBreakNode,
  $getNodeByKey,
  $getRoot,
  type LexicalEditor,
  type NodeKey,
} from 'lexical';
import {initializeUnitTest} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, it} from 'vitest';

function getGutter(editor: LexicalEditor, key: NodeKey): string | null {
  const codeElement = editor.getElementByKey(key);
  assert(codeElement !== null, 'expected the CodeNode to be rendered');
  return codeElement.getAttribute('data-gutter');
}

describe('registerCodeGutter', () => {
  initializeUnitTest(testEnv => {
    it('numbers a single line', async () => {
      const {editor} = testEnv;
      registerCodeGutter(editor);

      let key!: NodeKey;
      await editor.update(() => {
        const codeNode = $createCodeNode('javascript');
        codeNode.append($createCodeHighlightNode('const a = 1;'));
        $getRoot().append(codeNode);
        key = codeNode.getKey();
      });

      expect(getGutter(editor, key)).toBe('1');
    });

    it('numbers several lines', async () => {
      const {editor} = testEnv;
      registerCodeGutter(editor);

      let key!: NodeKey;
      await editor.update(() => {
        const codeNode = $createCodeNode('javascript');
        codeNode.append(
          $createCodeHighlightNode('a'),
          $createLineBreakNode(),
          $createCodeHighlightNode('b'),
          $createLineBreakNode(),
          $createCodeHighlightNode('c'),
        );
        $getRoot().append(codeNode);
        key = codeNode.getKey();
      });

      expect(getGutter(editor, key)).toBe('1\n2\n3');
    });

    it('numbers an empty trailing line', async () => {
      const {editor} = testEnv;
      registerCodeGutter(editor);

      let key!: NodeKey;
      await editor.update(() => {
        const codeNode = $createCodeNode('javascript');
        codeNode.append($createCodeHighlightNode('a'), $createLineBreakNode());
        $getRoot().append(codeNode);
        key = codeNode.getKey();
      });

      expect(getGutter(editor, key)).toBe('1\n2');
    });

    it('follows an edit that changes the line count', async () => {
      const {editor} = testEnv;
      registerCodeGutter(editor);

      let key!: NodeKey;
      await editor.update(() => {
        const codeNode = $createCodeNode('javascript');
        codeNode.append(
          $createCodeHighlightNode('a'),
          $createLineBreakNode(),
          $createCodeHighlightNode('b'),
        );
        $getRoot().append(codeNode);
        key = codeNode.getKey();
      });
      expect(getGutter(editor, key)).toBe('1\n2');

      await editor.update(() => {
        const codeNode = $getNodeByKey(key);
        assert($isCodeNode(codeNode), 'expected a CodeNode');
        codeNode.append($createLineBreakNode(), $createCodeHighlightNode('c'));
      });
      expect(getGutter(editor, key)).toBe('1\n2\n3');

      await editor.update(() => {
        const codeNode = $getNodeByKey(key);
        assert($isCodeNode(codeNode), 'expected a CodeNode');
        codeNode.splice(1, codeNode.getChildrenSize() - 1, []);
      });
      expect(getGutter(editor, key)).toBe('1');
    });
  });
});
