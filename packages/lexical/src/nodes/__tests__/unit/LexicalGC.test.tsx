/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $isElementNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $createTestElementNode,
  generatePermutations,
  initializeUnitTest,
  invariant,
} from '../../../__tests__/utils';

describe('LexicalGC tests', () => {
  initializeUnitTest(testEnv => {
    test('RootNode.clear() with a child and subchild', async () => {
      const {editor} = testEnv;
      await editor.update(() => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('foo')),
        );
      });
      expect(editor.getEditorState()._nodeMap.size).toBe(3);
      await editor.update(() => {
        $getRoot().clear();
      });
      expect(editor.getEditorState()._nodeMap.size).toBe(1);
    });

    for (const parentFirst of [false, true]) {
      test(`collects newly created dirty subtrees, parent created first: ${parentFirst}`, async () => {
        const {editor} = testEnv;
        await editor.update(() => {
          const first = $createTestElementNode();
          const second = $createTestElementNode();
          const parent = parentFirst ? first : second;
          const child = parentFirst ? second : first;
          $getRoot().append(
            parent.append(
              child.append(
                $createParagraphNode().append($createTextNode('temporary')),
              ),
            ),
          );
          parent.remove();
        });
        expect([...editor.getEditorState()._nodeMap.keys()]).toEqual(['root']);
      });
    }

    test('RootNode.clear() with a child and three subchildren', async () => {
      const {editor} = testEnv;
      await editor.update(() => {
        const text1 = $createTextNode('foo');
        const text2 = $createTextNode('bar').toggleUnmergeable();
        const text3 = $createTextNode('zzz').toggleUnmergeable();
        const paragraph = $createParagraphNode();
        paragraph.append(text1, text2, text3);
        $getRoot().append(paragraph);
      });
      expect(editor.getEditorState()._nodeMap.size).toBe(5);
      await editor.update(() => {
        $getRoot().clear();
      });
      expect(editor.getEditorState()._nodeMap.size).toBe(1);
    });

    for (let i = 0; i < 3; i++) {
      test(`RootNode.clear() with a child and three subchildren, subchild ${i} removed first`, async () => {
        const {editor} = testEnv;
        await editor.update(() => {
          const text1 = $createTextNode('foo'); // 1
          const text2 = $createTextNode('bar').toggleUnmergeable(); // 2
          const text3 = $createTextNode('zzz').toggleUnmergeable(); // 3
          const paragraph = $createParagraphNode(); // 4
          paragraph.append(text1, text2, text3);
          $getRoot().append(paragraph);
        });
        expect(editor.getEditorState()._nodeMap.size).toBe(5);
        await editor.update(() => {
          const root = $getRoot();
          const firstChild = root.getFirstChild();
          invariant($isElementNode(firstChild));
          const subchild = firstChild.getChildAtIndex(i)!;
          expect(subchild.getTextContent()).toBe(['foo', 'bar', 'zzz'][i]);
          subchild.remove();
          root.clear();
        });
        expect(editor.getEditorState()._nodeMap.size).toEqual(1);
      });
    }

    const permutations2 = generatePermutations<string>(
      ['1', '2', '3', '4', '5', '6'],
      2,
    );
    for (let i = 0; i < permutations2.length; i++) {
      const removeKeys = permutations2[i];
      /**
       *          R
       *          P
       *     T   TE    T
       *        T  T
       */
      test(`RootNode.clear() with a complex tree, nodes ${removeKeys.toString()} removed first`, async () => {
        const {editor} = testEnv;
        await editor.update(() => {
          const testElement = $createTestElementNode(); // 1
          const testElementText1 = $createTextNode('te1').toggleUnmergeable(); // 2
          const testElementText2 = $createTextNode('te2').toggleUnmergeable(); // 3
          const text1 = $createTextNode('a').toggleUnmergeable(); // 4
          const text2 = $createTextNode('b').toggleUnmergeable(); // 5
          const paragraph = $createParagraphNode(); // 6
          testElement.append(testElementText1, testElementText2);
          paragraph.append(text1, testElement, text2);
          $getRoot().append(paragraph);
        });
        expect(editor.getEditorState()._nodeMap.size).toBe(7);
        await editor.update(() => {
          for (const key of removeKeys) {
            const node = $getNodeByKey(String(key))!;
            node.remove();
          }
          $getRoot().clear();
        });
        expect(editor.getEditorState()._nodeMap.size).toEqual(1);
      });
    }
  });
});
