/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $applyNodeReplacement,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type LexicalNode,
  TextNode,
} from 'lexical';
import {initializeUnitTest} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

import {type EntityMatch, registerLexicalTextEntity} from '../..';

class TestEntityNode extends TextNode {
  $config() {
    return this.config('test-entity', {extends: TextNode});
  }

  isTextEntity(): true {
    return true;
  }
}

function $createTestEntityNode(text: string): TestEntityNode {
  return $applyNodeReplacement(new TestEntityNode(text));
}

function $isTestEntityNode(node: LexicalNode | null): node is TestEntityNode {
  return node instanceof TestEntityNode;
}

function getMatch(text: string): null | EntityMatch {
  const match = /#\w+/.exec(text);
  return match === null
    ? null
    : {end: match.index + match[0].length, start: match.index};
}

describe('registerLexicalTextEntity', () => {
  initializeUnitTest(
    testEnv => {
      test('preserves style and detail when reverting an entity to simple text', async () => {
        const {editor} = testEnv;
        registerLexicalTextEntity(editor, getMatch, TestEntityNode, textNode =>
          $createTestEntityNode(textNode.getTextContent()),
        );

        await editor.update(() => {
          const paragraph = $createParagraphNode();
          paragraph.append($createTextNode('#lexical'));
          $getRoot().clear().append(paragraph);
        });

        await editor.update(() => {
          const node = $getRoot().getFirstDescendant();
          expect($isTestEntityNode(node)).toBe(true);
          (node as TestEntityNode)
            .setFormat('bold')
            .setStyle('color: red')
            .setDetail('directionless');
        });

        // Break the match so the entity reverts to a plain TextNode.
        await editor.update(() => {
          const node = $getRoot().getFirstDescendant() as TextNode;
          node.setTextContent('lexical');
        });

        editor.getEditorState().read(() => {
          const node = $getRoot().getFirstDescendant() as TextNode;
          expect($isTestEntityNode(node)).toBe(false);
          expect(node.getTextContent()).toBe('lexical');
          expect(node.hasFormat('bold')).toBe(true);
          expect(node.getStyle()).toBe('color: red');
          expect(node.isDirectionless()).toBe(true);
        });
      });
    },
    {namespace: 'test', nodes: [TestEntityNode], theme: {}},
  );
});
