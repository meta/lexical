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
  $getRoot,
  $setCompositionKey,
  COLLABORATION_TAG,
  DEFER_COMPOSITION_MERGE_TAG,
  type ParagraphNode,
  type RangeSelection,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {$normalizeSelection} from '../../LexicalNormalization';
import {
  $createTestDecoratorNode,
  $createTestElementNode,
  initializeUnitTest,
} from '../utils';

describe('LexicalNormalization tests', () => {
  initializeUnitTest(testEnv => {
    describe('text nodes next to a composition', () => {
      const $paragraph = () => $getRoot().getFirstChild() as ParagraphNode;
      const texts = () =>
        editor()
          .getEditorState()
          .read(() =>
            $paragraph()
              .getChildren()
              .map(t => t.getTextContent()),
          );
      const editor = () => testEnv.editor;
      async function startComposition(): Promise<string> {
        let composedKey = '';
        await editor().update(() => {
          const composed = $createTextNode('にj2z');
          $getRoot().clear().append($createParagraphNode().append(composed));
          composedKey = composed.getKey();
          composed.select(1, 1);
          $setCompositionKey(composedKey);
        });
        return composedKey;
      }
      // Text from another source lands right before the composition.
      const insertBefore = (tag?: string) =>
        editor().update(
          () => {
            $paragraph()
              .getLastChildOrThrow()
              .insertBefore($createTextNode('j1z'));
          },
          {tag},
        );
      const compositionStep = () =>
        editor().update(() => {
          const node = $paragraph().getLastChildOrThrow() as TextNode;
          node.setTextContent(node.getTextContent().replace('に', 'にほ'));
        });

      test('text tagged DEFER_COMPOSITION_MERGE_TAG is not merged into the composed node until it ends', async () => {
        const composedKey = await startComposition();
        await insertBefore(DEFER_COMPOSITION_MERGE_TAG);
        expect(texts()).toEqual(['j1z', 'にj2z']);
        editor()
          .getEditorState()
          .read(() =>
            expect($paragraph().getLastChildOrThrow().getKey()).toBe(
              composedKey,
            ),
          );
        // Later steps of the same composition do not merge either.
        await compositionStep();
        expect(texts()).toEqual(['j1z', 'にほj2z']);
        editor()
          .getEditorState()
          .read(() =>
            expect($paragraph().getLastChildOrThrow().getKey()).toBe(
              composedKey,
            ),
          );
        // The composition ends: the nodes merge.
        await editor().update(() => $setCompositionKey(null));
        expect(texts()).toEqual(['j1zにほj2z']);
      });

      test('text inserted without the tag merges at once', async () => {
        await startComposition();
        await insertBefore();
        expect(texts()).toEqual(['j1zにj2z']);
      });

      test('COLLABORATION_TAG alone merges at once', async () => {
        await startComposition();
        await insertBefore(COLLABORATION_TAG);
        expect(texts()).toEqual(['j1zにj2z']);
        await compositionStep();
        expect(texts()).toEqual(['j1zにほj2z']);
      });

      test('a new composition of the same node merges as usual', async () => {
        const composedKey = await startComposition();
        await insertBefore(DEFER_COMPOSITION_MERGE_TAG);
        expect(texts()).toEqual(['j1z', 'にj2z']);
        // The composition is reset without normalizing (as setEditorState
        // does), then a new one starts on the same node: nothing is held.
        await editor().update(() => {
          testEnv.editor._compositionKey = null;
        });
        await editor().update(() => $setCompositionKey(composedKey));
        expect(texts()).toEqual(['j1zにj2z']);
        await insertBefore();
        expect(texts()).toEqual(['j1zj1zにj2z']);
      });
    });

    describe('$normalizeSelection', () => {
      for (const reversed of [false, true]) {
        const getAnchor = (x: RangeSelection) =>
          reversed ? x.focus : x.anchor;
        const getFocus = (x: RangeSelection) => (reversed ? x.anchor : x.focus);
        const reversedStr = reversed ? ' (reversed)' : '';

        test(`paragraph to text nodes${reversedStr}`, async () => {
          const {editor} = testEnv;
          editor.update(() => {
            const root = $getRoot();
            const paragraph = $createParagraphNode();
            const text1 = $createTextNode('a');
            const text2 = $createTextNode('b');
            paragraph.append(text1, text2);
            root.append(paragraph);

            const selection = paragraph.select();
            getAnchor(selection).set(paragraph.__key, 0, 'element');
            getFocus(selection).set(paragraph.__key, 2, 'element');

            const normalizedSelection = $normalizeSelection(selection);
            expect(getAnchor(normalizedSelection).type).toBe('text');
            expect(getAnchor(normalizedSelection).getNode().__key).toBe(
              text1.__key,
            );
            expect(getAnchor(normalizedSelection).offset).toBe(0);
            expect(getFocus(normalizedSelection).type).toBe('text');
            expect(getFocus(normalizedSelection).getNode().__key).toBe(
              text2.__key,
            );
            expect(getFocus(normalizedSelection).offset).toBe(1);
          });
        });

        test(`paragraph to text node + element${reversedStr}`, async () => {
          const {editor} = testEnv;
          editor.update(() => {
            const root = $getRoot();
            const paragraph = $createParagraphNode();
            const text1 = $createTextNode('a');
            const elementNode = $createTestElementNode();
            paragraph.append(text1, elementNode);
            root.append(paragraph);

            const selection = paragraph.select();
            getAnchor(selection).set(paragraph.__key, 0, 'element');
            getFocus(selection).set(paragraph.__key, 2, 'element');

            const normalizedSelection = $normalizeSelection(selection);
            expect(getAnchor(normalizedSelection).type).toBe('text');
            expect(getAnchor(normalizedSelection).getNode().__key).toBe(
              text1.__key,
            );
            expect(getAnchor(normalizedSelection).offset).toBe(0);
            expect(getFocus(normalizedSelection).type).toBe('element');
            expect(getFocus(normalizedSelection).getNode().__key).toBe(
              elementNode.__key,
            );
            expect(getFocus(normalizedSelection).offset).toBe(0);
          });
        });

        test(`paragraph to text node + decorator${reversedStr}`, async () => {
          const {editor} = testEnv;
          editor.update(() => {
            const root = $getRoot();
            const paragraph = $createParagraphNode();
            const text1 = $createTextNode('a');
            const decoratorNode = $createTestDecoratorNode();
            paragraph.append(text1, decoratorNode);
            root.append(paragraph);

            const selection = paragraph.select();
            getAnchor(selection).set(paragraph.__key, 0, 'element');
            getFocus(selection).set(paragraph.__key, 2, 'element');

            const normalizedSelection = $normalizeSelection(selection);
            expect(getAnchor(normalizedSelection).type).toBe('text');
            expect(getAnchor(normalizedSelection).getNode().__key).toBe(
              text1.__key,
            );
            expect(getAnchor(normalizedSelection).offset).toBe(0);
            expect(getFocus(normalizedSelection).type).toBe('element');
            expect(getFocus(normalizedSelection).getNode().__key).toBe(
              paragraph.__key,
            );
            expect(getFocus(normalizedSelection).offset).toBe(2);
          });
        });

        test(`text + text node${reversedStr}`, async () => {
          const {editor} = testEnv;
          editor.update(() => {
            const root = $getRoot();
            const paragraph = $createParagraphNode();
            const text1 = $createTextNode('a');
            const text2 = $createTextNode('b');
            paragraph.append(text1, text2);
            root.append(paragraph);

            const selection = paragraph.select();
            getAnchor(selection).set(text1.__key, 0, 'text');
            getFocus(selection).set(text2.__key, 1, 'text');

            const normalizedSelection = $normalizeSelection(selection);
            expect(getAnchor(normalizedSelection).type).toBe('text');
            expect(getAnchor(normalizedSelection).getNode().__key).toBe(
              text1.__key,
            );
            expect(getAnchor(normalizedSelection).offset).toBe(0);
            expect(getFocus(normalizedSelection).type).toBe('text');
            expect(getFocus(normalizedSelection).getNode().__key).toBe(
              text2.__key,
            );
            expect(getFocus(normalizedSelection).offset).toBe(1);
          });
        });

        test(`paragraph to test element to text + text${reversedStr}`, async () => {
          const {editor} = testEnv;
          editor.update(() => {
            const root = $getRoot();
            const paragraph = $createParagraphNode();
            const elementNode = $createTestElementNode();
            const text1 = $createTextNode('a');
            const text2 = $createTextNode('b');
            elementNode.append(text1, text2);
            paragraph.append(elementNode);
            root.append(paragraph);

            const selection = paragraph.select();
            getAnchor(selection).set(text1.__key, 0, 'text');
            getFocus(selection).set(text2.__key, 1, 'text');

            const normalizedSelection = $normalizeSelection(selection);
            expect(getAnchor(normalizedSelection).type).toBe('text');
            expect(getAnchor(normalizedSelection).getNode().__key).toBe(
              text1.__key,
            );
            expect(getAnchor(normalizedSelection).offset).toBe(0);
            expect(getFocus(normalizedSelection).type).toBe('text');
            expect(getFocus(normalizedSelection).getNode().__key).toBe(
              text2.__key,
            );
            expect(getFocus(normalizedSelection).offset).toBe(1);
          });
        });
      }
    });
  });
});
