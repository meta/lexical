/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$createLinkNode} from '@lexical/link';
import {$createHeadingNode, $isHeadingNode} from '@lexical/rich-text';
import {
  $getSelectionStyleValueForProperty,
  $patchStyleText,
} from '@lexical/selection';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $insertNodes,
  $isElementNode,
  $isParagraphNode,
  $isRangeSelection,
  $setSelection,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type ParagraphNode,
  type RangeSelection,
  type TextModeType,
  TextNode,
} from 'lexical';
import {
  $createTestDecoratorNode,
  $createTestElementNode,
  $createTestShadowRootNode,
  createTestEditor,
  createTestHeadlessEditor,
  invariant,
  TestDecoratorNode,
} from 'lexical/src/__tests__/utils';
import {afterEach, describe, expect, it, test, vi} from 'vitest';

import {$setAnchorPoint, $setFocusPoint} from '../utils';

Range.prototype.getBoundingClientRect = function (): DOMRect {
  const rect = {
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
    x: 0,
    y: 0,
  };
  return {
    ...rect,
    toJSON() {
      return rect;
    },
  };
};

function $createParagraphWithNodes(
  editor: LexicalEditor,
  nodes: {text: string; key: string; mergeable?: boolean}[],
) {
  const paragraph = $createParagraphNode();
  const nodeMap = editor._pendingEditorState!._nodeMap;

  for (let i = 0; i < nodes.length; i++) {
    const {text, key, mergeable} = nodes[i];
    const textNode = new TextNode(text, key);
    nodeMap.set(key, textNode);

    if (!mergeable) {
      textNode.toggleUnmergeable();
    }

    paragraph.append(textNode);
  }

  return paragraph;
}

describe('LexicalSelectionHelpers tests', () => {
  describe('Collapsed', () => {
    test('Can handle a text point', () => {
      const setupTestCase = (
        cb: (selection: RangeSelection, node: ElementNode) => void,
      ) => {
        const editor = createTestEditor();

        editor.update(() => {
          const root = $getRoot();

          const element = $createParagraphWithNodes(editor, [
            {
              key: 'a',
              mergeable: false,
              text: 'a',
            },
            {
              key: 'b',
              mergeable: false,
              text: 'b',
            },
            {
              key: 'c',
              mergeable: false,
              text: 'c',
            },
          ]);

          root.append(element);

          $setAnchorPoint({
            key: 'a',
            offset: 0,
            type: 'text',
          });

          $setFocusPoint({
            key: 'a',
            offset: 0,
            type: 'text',
          });
          const selection = $getSelection();
          cb(selection as RangeSelection, element);
        });
      };

      // getNodes
      setupTestCase((selection, state) => {
        expect(selection.getNodes()).toEqual([$getNodeByKey('a')]);
      });

      // getTextContent
      setupTestCase(selection => {
        expect(selection.getTextContent()).toEqual('');
      });

      // insertText
      setupTestCase((selection, state) => {
        selection.insertText('Test');

        expect($getNodeByKey('a')!.getTextContent()).toBe('Testa');

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: 'a',
            offset: 4,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: 'a',
            offset: 4,
            type: 'text',
          }),
        );
      });

      // insertNodes
      setupTestCase((selection, element) => {
        selection.insertNodes([$createTextNode('foo')]);

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: element.getFirstChild()!.getKey(),
            offset: 3,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: element.getFirstChild()!.getKey(),
            offset: 3,
            type: 'text',
          }),
        );
      });

      // insertParagraph
      setupTestCase(selection => {
        selection.insertParagraph();

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: 'a',
            offset: 0,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: 'a',
            offset: 0,
            type: 'text',
          }),
        );
      });

      // insertLineBreak
      setupTestCase((selection, element) => {
        selection.insertLineBreak(true);

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: element.getKey(),
            offset: 0,
            type: 'element',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: element.getKey(),
            offset: 0,
            type: 'element',
          }),
        );
      });

      // Format text
      setupTestCase((selection, element) => {
        selection.formatText('bold');
        selection.insertText('Test');

        expect(element.getFirstChild()!.getTextContent()).toBe('Test');

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: element.getFirstChild()!.getKey(),
            offset: 4,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: element.getFirstChild()!.getKey(),
            offset: 4,
            type: 'text',
          }),
        );

        expect(
          element.getFirstChild()!.getNextSibling()!.getTextContent(),
        ).toBe('a');
      });

      // Extract selection
      setupTestCase((selection, state) => {
        expect(selection.extract()).toEqual([$getNodeByKey('a')]);
      });
    });

    test('Has correct text point after removal after merge', async () => {
      const editor = createTestEditor();

      const domElement = document.createElement('div');
      let element;

      editor.setRootElement(domElement);

      editor.update(() => {
        const root = $getRoot();

        element = $createParagraphWithNodes(editor, [
          {
            key: 'a',
            mergeable: true,
            text: 'a',
          },
          {
            key: 'bb',
            mergeable: true,
            text: 'bb',
          },
          {
            key: 'empty',
            mergeable: true,
            text: '',
          },
          {
            key: 'cc',
            mergeable: true,
            text: 'cc',
          },
          {
            key: 'd',
            mergeable: true,
            text: 'd',
          },
        ]);

        root.append(element);

        $setAnchorPoint({
          key: 'bb',
          offset: 1,
          type: 'text',
        });

        $setFocusPoint({
          key: 'cc',
          offset: 1,
          type: 'text',
        });
      });

      await Promise.resolve().then();

      editor.read('latest', () => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return;
        }

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: 'a',
            offset: 2,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: 'a',
            offset: 4,
            type: 'text',
          }),
        );
      });
    });

    test('Has correct text point after removal after merge (2)', async () => {
      const editor = createTestEditor();

      const domElement = document.createElement('div');
      let element;

      editor.setRootElement(domElement);

      editor.update(() => {
        const root = $getRoot();

        element = $createParagraphWithNodes(editor, [
          {
            key: 'a',
            mergeable: true,
            text: 'a',
          },
          {
            key: 'empty',
            mergeable: true,
            text: '',
          },
          {
            key: 'b',
            mergeable: true,
            text: 'b',
          },
          {
            key: 'c',
            mergeable: true,
            text: 'c',
          },
        ]);

        root.append(element);

        $setAnchorPoint({
          key: 'a',
          offset: 0,
          type: 'text',
        });

        $setFocusPoint({
          key: 'c',
          offset: 1,
          type: 'text',
        });
      });

      await Promise.resolve().then();

      editor.read('latest', () => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return;
        }

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: 'a',
            offset: 0,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: 'a',
            offset: 3,
            type: 'text',
          }),
        );
      });
    });

    test('Has correct text point adjust to element point after removal of a single empty text node', async () => {
      const editor = createTestEditor();

      const domElement = document.createElement('div');
      let element: ParagraphNode;

      editor.setRootElement(domElement);

      editor.update(() => {
        const root = $getRoot();

        element = $createParagraphWithNodes(editor, [
          {
            key: 'a',
            mergeable: true,
            text: '',
          },
        ]);

        root.append(element);

        $setAnchorPoint({
          key: 'a',
          offset: 0,
          type: 'text',
        });

        $setFocusPoint({
          key: 'a',
          offset: 0,
          type: 'text',
        });
      });

      await Promise.resolve().then();

      editor.read('latest', () => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return;
        }

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: element.getKey(),
            offset: 0,
            type: 'element',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: element.getKey(),
            offset: 0,
            type: 'element',
          }),
        );
      });
    });

    test('Has correct element point after removal of an empty text node in a group #1', async () => {
      const editor = createTestEditor();

      const domElement = document.createElement('div');
      let element;

      editor.setRootElement(domElement);

      editor.update(() => {
        const root = $getRoot();

        element = $createParagraphWithNodes(editor, [
          {
            key: 'a',
            mergeable: true,
            text: '',
          },
          {
            key: 'b',
            mergeable: false,
            text: 'b',
          },
        ]);

        root.append(element);

        $setAnchorPoint({
          key: element.getKey(),
          offset: 2,
          type: 'element',
        });

        $setFocusPoint({
          key: element.getKey(),
          offset: 2,
          type: 'element',
        });
      });

      await Promise.resolve().then();

      editor.read('latest', () => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return;
        }

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: 'b',
            offset: 1,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: 'b',
            offset: 1,
            type: 'text',
          }),
        );
      });
    });

    test('Has correct element point after removal of an empty text node in a group #2', async () => {
      const editor = createTestEditor();

      const domElement = document.createElement('div');
      let element;

      editor.setRootElement(domElement);

      editor.update(() => {
        const root = $getRoot();

        element = $createParagraphWithNodes(editor, [
          {
            key: 'a',
            mergeable: true,
            text: '',
          },
          {
            key: 'b',
            mergeable: false,
            text: 'b',
          },
          {
            key: 'c',
            mergeable: true,
            text: 'c',
          },
          {
            key: 'd',
            mergeable: true,
            text: 'd',
          },
        ]);

        root.append(element);

        $setAnchorPoint({
          key: element.getKey(),
          offset: 4,
          type: 'element',
        });

        $setFocusPoint({
          key: element.getKey(),
          offset: 4,
          type: 'element',
        });
      });

      await Promise.resolve().then();

      editor.read('latest', () => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return;
        }

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: 'c',
            offset: 2,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: 'c',
            offset: 2,
            type: 'text',
          }),
        );
      });
    });

    test('Has correct text point after removal of an empty text node in a group #3', async () => {
      const editor = createTestEditor();

      const domElement = document.createElement('div');
      let element;

      editor.setRootElement(domElement);

      editor.update(() => {
        const root = $getRoot();

        element = $createParagraphWithNodes(editor, [
          {
            key: 'a',
            mergeable: true,
            text: '',
          },
          {
            key: 'b',
            mergeable: false,
            text: 'b',
          },
          {
            key: 'c',
            mergeable: true,
            text: 'c',
          },
          {
            key: 'd',
            mergeable: true,
            text: 'd',
          },
        ]);

        root.append(element);

        $setAnchorPoint({
          key: 'd',
          offset: 1,
          type: 'text',
        });

        $setFocusPoint({
          key: 'd',
          offset: 1,
          type: 'text',
        });
      });

      await Promise.resolve().then();

      editor.read('latest', () => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return;
        }

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: 'c',
            offset: 2,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: 'c',
            offset: 2,
            type: 'text',
          }),
        );
      });
    });

    test('Can handle an element point on empty element', () => {
      const setupTestCase = (
        cb: (selection: RangeSelection, el: ElementNode) => void,
      ) => {
        const editor = createTestEditor();

        editor.update(() => {
          const root = $getRoot();

          const element = $createParagraphWithNodes(editor, []);

          root.append(element);

          $setAnchorPoint({
            key: element.getKey(),
            offset: 0,
            type: 'element',
          });

          $setFocusPoint({
            key: element.getKey(),
            offset: 0,
            type: 'element',
          });
          const selection = $getSelection();
          cb(selection as RangeSelection, element);
        });
      };

      // getNodes
      setupTestCase((selection, element) => {
        expect(selection.getNodes()).toEqual([element]);
      });

      // getTextContent
      setupTestCase(selection => {
        expect(selection.getTextContent()).toEqual('');
      });

      // insertText
      setupTestCase((selection, element) => {
        selection.insertText('Test');
        const firstChild = element.getFirstChild()!;

        expect(firstChild.getTextContent()).toBe('Test');

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: firstChild.getKey(),
            offset: 4,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: firstChild.getKey(),
            offset: 4,
            type: 'text',
          }),
        );
      });

      // insertParagraph
      setupTestCase((selection, element) => {
        selection.insertParagraph();
        const nextElement = element.getNextSibling()!;

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: nextElement.getKey(),
            offset: 0,
            type: 'element',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: nextElement.getKey(),
            offset: 0,
            type: 'element',
          }),
        );
      });

      // insertLineBreak
      setupTestCase((selection, element) => {
        selection.insertLineBreak(true);

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: element.getKey(),
            offset: 0,
            type: 'element',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: element.getKey(),
            offset: 0,
            type: 'element',
          }),
        );
      });

      // Format text
      setupTestCase((selection, element) => {
        selection.formatText('bold');
        selection.insertText('Test');
        const firstChild = element.getFirstChild()!;

        expect(firstChild.getTextContent()).toBe('Test');

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: firstChild.getKey(),
            offset: 4,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: firstChild.getKey(),
            offset: 4,
            type: 'text',
          }),
        );
      });

      // Extract selection
      setupTestCase((selection, element) => {
        expect(selection.extract()).toEqual([element]);
      });
    });

    test('Can handle a start element point', () => {
      const setupTestCase = (
        cb: (selection: RangeSelection, el: ElementNode) => void,
      ) => {
        const editor = createTestEditor();

        editor.update(() => {
          const root = $getRoot();

          const element = $createParagraphWithNodes(editor, [
            {
              key: 'a',
              mergeable: false,
              text: 'a',
            },
            {
              key: 'b',
              mergeable: false,
              text: 'b',
            },
            {
              key: 'c',
              mergeable: false,
              text: 'c',
            },
          ]);

          root.append(element);

          $setAnchorPoint({
            key: element.getKey(),
            offset: 0,
            type: 'element',
          });

          $setFocusPoint({
            key: element.getKey(),
            offset: 0,
            type: 'element',
          });
          const selection = $getSelection();
          cb(selection as RangeSelection, element);
        });
      };

      // getNodes
      setupTestCase((selection, state) => {
        expect(selection.getNodes()).toEqual([$getNodeByKey('a')]);
      });

      // getTextContent
      setupTestCase(selection => {
        expect(selection.getTextContent()).toEqual('');
      });

      // insertText
      setupTestCase((selection, element) => {
        selection.insertText('Test');
        const firstChild = element.getFirstChild()!;

        expect(firstChild.getTextContent()).toBe('Test');

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: firstChild.getKey(),
            offset: 4,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: firstChild.getKey(),
            offset: 4,
            type: 'text',
          }),
        );
      });

      // insertParagraph
      setupTestCase((selection, element) => {
        selection.insertParagraph();

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: 'a',
            offset: 0,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: 'a',
            offset: 0,
            type: 'text',
          }),
        );
      });

      // insertLineBreak
      setupTestCase((selection, element) => {
        selection.insertLineBreak(true);

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: element.getKey(),
            offset: 0,
            type: 'element',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: element.getKey(),
            offset: 0,
            type: 'element',
          }),
        );
      });

      // Format text
      setupTestCase((selection, element) => {
        selection.formatText('bold');
        selection.insertText('Test');

        const firstChild = element.getFirstChild()!;

        expect(firstChild.getTextContent()).toBe('Test');

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: firstChild.getKey(),
            offset: 4,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: firstChild.getKey(),
            offset: 4,
            type: 'text',
          }),
        );
      });

      // Extract selection
      setupTestCase((selection, element) => {
        expect(selection.extract()).toEqual([$getNodeByKey('a')]);
      });
    });

    test('Can handle an end element point', () => {
      const setupTestCase = (
        cb: (selection: RangeSelection, el: ElementNode) => void,
      ) => {
        const editor = createTestEditor();

        editor.update(() => {
          const root = $getRoot();

          const element = $createParagraphWithNodes(editor, [
            {
              key: 'a',
              mergeable: false,
              text: 'a',
            },
            {
              key: 'b',
              mergeable: false,
              text: 'b',
            },
            {
              key: 'c',
              mergeable: false,
              text: 'c',
            },
          ]);

          root.append(element);

          $setAnchorPoint({
            key: element.getKey(),
            offset: 3,
            type: 'element',
          });

          $setFocusPoint({
            key: element.getKey(),
            offset: 3,
            type: 'element',
          });
          const selection = $getSelection();
          cb(selection as RangeSelection, element);
        });
      };

      // getNodes
      setupTestCase((selection, state) => {
        expect(selection.getNodes()).toEqual([$getNodeByKey('c')]);
      });

      // getTextContent
      setupTestCase(selection => {
        expect(selection.getTextContent()).toEqual('');
      });

      // insertText
      setupTestCase((selection, element) => {
        selection.insertText('Test');
        const lastChild = element.getLastChild()!;

        expect(lastChild.getTextContent()).toBe('Test');

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: lastChild.getKey(),
            offset: 4,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: lastChild.getKey(),
            offset: 4,
            type: 'text',
          }),
        );
      });

      // insertParagraph
      setupTestCase((selection, element) => {
        selection.insertParagraph();
        const nextSibling = element.getNextSibling()!;

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: nextSibling.getKey(),
            offset: 0,
            type: 'element',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: nextSibling.getKey(),
            offset: 0,
            type: 'element',
          }),
        );
      });

      // insertLineBreak
      setupTestCase((selection, element) => {
        selection.insertLineBreak();

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: element.getKey(),
            offset: 4,
            type: 'element',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: element.getKey(),
            offset: 4,
            type: 'element',
          }),
        );
      });

      // Format text
      setupTestCase((selection, element) => {
        selection.formatText('bold');
        selection.insertText('Test');
        const lastChild = element.getLastChild()!;

        expect(lastChild.getTextContent()).toBe('Test');

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: lastChild.getKey(),
            offset: 4,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: lastChild.getKey(),
            offset: 4,
            type: 'text',
          }),
        );
      });

      // Extract selection
      setupTestCase((selection, element) => {
        expect(selection.extract()).toEqual([$getNodeByKey('c')]);
      });
    });

    test('Has correct element point after merge from middle', async () => {
      const editor = createTestEditor();

      const domElement = document.createElement('div');
      let element;

      editor.setRootElement(domElement);

      editor.update(() => {
        const root = $getRoot();

        element = $createParagraphWithNodes(editor, [
          {
            key: 'a',
            mergeable: true,
            text: 'a',
          },
          {
            key: 'b',
            mergeable: true,
            text: 'b',
          },
          {
            key: 'c',
            mergeable: true,
            text: 'c',
          },
        ]);

        root.append(element);

        $setAnchorPoint({
          key: element.getKey(),
          offset: 2,
          type: 'element',
        });

        $setFocusPoint({
          key: element.getKey(),
          offset: 2,
          type: 'element',
        });
      });

      await Promise.resolve().then();

      editor.read('latest', () => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return;
        }

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: 'a',
            offset: 2,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: 'a',
            offset: 2,
            type: 'text',
          }),
        );
      });
    });

    test('Has correct element point after merge from end', async () => {
      const editor = createTestEditor();

      const domElement = document.createElement('div');
      let element;

      editor.setRootElement(domElement);

      editor.update(() => {
        const root = $getRoot();

        element = $createParagraphWithNodes(editor, [
          {
            key: 'a',
            mergeable: true,
            text: 'a',
          },
          {
            key: 'b',
            mergeable: true,
            text: 'b',
          },
          {
            key: 'c',
            mergeable: true,
            text: 'c',
          },
        ]);

        root.append(element);

        $setAnchorPoint({
          key: element.getKey(),
          offset: 3,
          type: 'element',
        });

        $setFocusPoint({
          key: element.getKey(),
          offset: 3,
          type: 'element',
        });
      });

      await Promise.resolve().then();

      editor.read('latest', () => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return;
        }

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: 'a',
            offset: 3,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: 'a',
            offset: 3,
            type: 'text',
          }),
        );
      });
    });
  });

  describe('Simple range', () => {
    test('Can handle multiple text points', () => {
      const setupTestCase = (
        cb: (selection: RangeSelection, el: ElementNode) => void,
      ) => {
        const editor = createTestEditor();

        editor.update(() => {
          const root = $getRoot();

          const element = $createParagraphWithNodes(editor, [
            {
              key: 'a',
              mergeable: false,
              text: 'a',
            },
            {
              key: 'b',
              mergeable: false,
              text: 'b',
            },
            {
              key: 'c',
              mergeable: false,
              text: 'c',
            },
          ]);

          root.append(element);

          $setAnchorPoint({
            key: 'a',
            offset: 0,
            type: 'text',
          });

          $setFocusPoint({
            key: 'b',
            offset: 0,
            type: 'text',
          });
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) {
            return;
          }
          cb(selection, element);
        });
      };

      // getNodes
      setupTestCase((selection, state) => {
        expect(selection.getNodes()).toEqual([
          $getNodeByKey('a'),
          $getNodeByKey('b'),
        ]);
      });

      // getTextContent
      setupTestCase(selection => {
        expect(selection.getTextContent()).toEqual('a');
      });

      // insertText
      setupTestCase((selection, state) => {
        selection.insertText('Test');

        const firstChild = state.getFirstChild()!;
        expect(firstChild.getTextContent()).toBe('Test');

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: firstChild.getKey(),
            offset: 4,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: firstChild.getKey(),
            offset: 4,
            type: 'text',
          }),
        );
      });

      // insertNodes
      setupTestCase((selection, element) => {
        selection.insertNodes([$createTextNode('foo')]);

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: element.getFirstChild()!.getKey(),
            offset: 3,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: element.getFirstChild()!.getKey(),
            offset: 3,
            type: 'text',
          }),
        );
      });

      // insertParagraph
      setupTestCase(selection => {
        selection.insertParagraph();

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: 'b',
            offset: 0,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: 'b',
            offset: 0,
            type: 'text',
          }),
        );
      });

      // insertLineBreak
      setupTestCase((selection, element) => {
        selection.insertLineBreak(true);

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: element.getKey(),
            offset: 0,
            type: 'element',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: element.getKey(),
            offset: 0,
            type: 'element',
          }),
        );
      });

      // Format text
      setupTestCase((selection, element) => {
        selection.formatText('bold');
        selection.insertText('Test');

        expect(element.getFirstChild()!.getTextContent()).toBe('Test');

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: element.getFirstChild()!.getKey(),
            offset: 4,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: element.getFirstChild()!.getKey(),
            offset: 4,
            type: 'text',
          }),
        );
      });

      // Extract selection
      setupTestCase((selection, state) => {
        expect(selection.extract()).toEqual([{...$getNodeByKey('a')}]);
      });
    });

    test('Can handle multiple element points', () => {
      const setupTestCase = (
        cb: (selection: RangeSelection, el: ElementNode) => void,
      ) => {
        const editor = createTestEditor();

        editor.update(() => {
          const root = $getRoot();

          const element = $createParagraphWithNodes(editor, [
            {
              key: 'a',
              mergeable: false,
              text: 'a',
            },
            {
              key: 'b',
              mergeable: false,
              text: 'b',
            },
            {
              key: 'c',
              mergeable: false,
              text: 'c',
            },
          ]);

          root.append(element);

          $setAnchorPoint({
            key: element.getKey(),
            offset: 0,
            type: 'element',
          });

          $setFocusPoint({
            key: element.getKey(),
            offset: 1,
            type: 'element',
          });
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) {
            return;
          }
          cb(selection, element);
        });
      };

      // getNodes
      setupTestCase(selection => {
        expect(selection.getNodes()).toEqual([$getNodeByKey('a')]);
      });

      // getTextContent
      setupTestCase(selection => {
        expect(selection.getTextContent()).toEqual('a');
      });

      // insertText
      setupTestCase((selection, element) => {
        selection.insertText('Test');
        const firstChild = element.getFirstChild()!;

        expect(firstChild.getTextContent()).toBe('Test');

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: firstChild.getKey(),
            offset: 4,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: firstChild.getKey(),
            offset: 4,
            type: 'text',
          }),
        );
      });

      // insertParagraph
      setupTestCase((selection, element) => {
        selection.insertParagraph();

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: 'b',
            offset: 0,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: 'b',
            offset: 0,
            type: 'text',
          }),
        );
      });

      // insertLineBreak
      setupTestCase((selection, element) => {
        selection.insertLineBreak(true);

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: element.getKey(),
            offset: 0,
            type: 'element',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: element.getKey(),
            offset: 0,
            type: 'element',
          }),
        );
      });

      // Format text
      setupTestCase((selection, element) => {
        selection.formatText('bold');
        selection.insertText('Test');
        const firstChild = element.getFirstChild()!;

        expect(firstChild.getTextContent()).toBe('Test');

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: firstChild.getKey(),
            offset: 4,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: firstChild.getKey(),
            offset: 4,
            type: 'text',
          }),
        );
      });

      // Extract selection
      setupTestCase((selection, element) => {
        const firstChild = element.getFirstChild();

        expect(selection.extract()).toEqual([firstChild]);
      });
    });

    test('Can handle a mix of text and element points', () => {
      const setupTestCase = (
        cb: (selection: RangeSelection, el: ElementNode) => void,
      ) => {
        const editor = createTestEditor();

        editor.update(() => {
          const root = $getRoot();

          const element = $createParagraphWithNodes(editor, [
            {
              key: 'a',
              mergeable: false,
              text: 'a',
            },
            {
              key: 'b',
              mergeable: false,
              text: 'b',
            },
            {
              key: 'c',
              mergeable: false,
              text: 'c',
            },
          ]);

          root.append(element);

          $setAnchorPoint({
            key: element.getKey(),
            offset: 0,
            type: 'element',
          });

          $setFocusPoint({
            key: 'c',
            offset: 1,
            type: 'text',
          });
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) {
            return;
          }
          cb(selection, element);
        });
      };

      // isBefore
      setupTestCase((selection, state) => {
        expect(selection.anchor.isBefore(selection.focus)).toEqual(true);
      });

      // getNodes
      setupTestCase((selection, state) => {
        expect(selection.getNodes()).toEqual([
          $getNodeByKey('a'),
          $getNodeByKey('b'),
          $getNodeByKey('c'),
        ]);
      });

      // getTextContent
      setupTestCase(selection => {
        expect(selection.getTextContent()).toEqual('abc');
      });

      // insertText
      setupTestCase((selection, element) => {
        selection.insertText('Test');
        const firstChild = element.getFirstChild()!;

        expect(firstChild.getTextContent()).toBe('Test');

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: firstChild.getKey(),
            offset: 4,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: firstChild.getKey(),
            offset: 4,
            type: 'text',
          }),
        );
      });

      // insertParagraph
      setupTestCase((selection, element) => {
        selection.insertParagraph();
        const nextElement = element.getNextSibling()!;

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: nextElement.getKey(),
            offset: 0,
            type: 'element',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: nextElement.getKey(),
            offset: 0,
            type: 'element',
          }),
        );
      });

      // insertLineBreak
      setupTestCase((selection, element) => {
        selection.insertLineBreak(true);

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: element.getKey(),
            offset: 0,
            type: 'element',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: element.getKey(),
            offset: 0,
            type: 'element',
          }),
        );
      });

      // Format text
      setupTestCase((selection, element) => {
        selection.formatText('bold');
        selection.insertText('Test');
        const firstChild = element.getFirstChild()!;

        expect(firstChild.getTextContent()).toBe('Test');

        expect(selection.anchor).toEqual(
          expect.objectContaining({
            key: firstChild.getKey(),
            offset: 4,
            type: 'text',
          }),
        );

        expect(selection.focus).toEqual(
          expect.objectContaining({
            key: firstChild.getKey(),
            offset: 4,
            type: 'text',
          }),
        );
      });

      // Extract selection
      setupTestCase((selection, element) => {
        expect(selection.extract()).toEqual([
          $getNodeByKey('a'),
          $getNodeByKey('b'),
          $getNodeByKey('c'),
        ]);
      });
    });
  });

  describe('can insert non-element nodes correctly', () => {
    describe('with an empty paragraph node selected', () => {
      test('a single text node', async () => {
        const editor = createTestEditor();

        const element = document.createElement('div');

        editor.setRootElement(element);

        await editor.update(() => {
          const root = $getRoot();

          const paragraph = $createParagraphNode();
          root.append(paragraph);

          $setAnchorPoint({
            key: paragraph.getKey(),
            offset: 0,
            type: 'element',
          });

          $setFocusPoint({
            key: paragraph.getKey(),
            offset: 0,
            type: 'element',
          });

          const selection = $getSelection();

          if (!$isRangeSelection(selection)) {
            return;
          }

          selection.insertNodes([$createTextNode('foo')]);
        });

        expect(element.innerHTML).toBe(
          '<p dir="auto"><span data-lexical-text="true">foo</span></p>',
        );
      });

      test('two text nodes', async () => {
        const editor = createTestEditor();

        const element = document.createElement('div');

        editor.setRootElement(element);

        await editor.update(() => {
          const root = $getRoot();

          const paragraph = $createParagraphNode();
          root.append(paragraph);

          $setAnchorPoint({
            key: paragraph.getKey(),
            offset: 0,
            type: 'element',
          });

          $setFocusPoint({
            key: paragraph.getKey(),
            offset: 0,
            type: 'element',
          });
          const selection = $getSelection();

          if (!$isRangeSelection(selection)) {
            return;
          }

          selection.insertNodes([
            $createTextNode('foo'),
            $createTextNode('bar'),
          ]);
        });

        expect(element.innerHTML).toBe(
          '<p dir="auto"><span data-lexical-text="true">foobar</span></p>',
        );
      });

      test('link insertion without parent element', async () => {
        const editor = createTestEditor();

        const element = document.createElement('div');

        editor.setRootElement(element);

        await editor.update(() => {
          const root = $getRoot();

          const paragraph = $createParagraphNode();
          root.append(paragraph);

          $setAnchorPoint({
            key: paragraph.getKey(),
            offset: 0,
            type: 'element',
          });

          $setFocusPoint({
            key: paragraph.getKey(),
            offset: 0,
            type: 'element',
          });
          const link = $createLinkNode('https://');
          link.append($createTextNode('ello worl'));

          const selection = $getSelection();

          if (!$isRangeSelection(selection)) {
            return;
          }

          selection.insertNodes([
            $createTextNode('h'),
            link,
            $createTextNode('d'),
          ]);
        });

        expect(element.innerHTML).toBe(
          '<p dir="auto"><span data-lexical-text="true">h</span><a href="https://"><span data-lexical-text="true">ello worl</span></a><span data-lexical-text="true">d</span></p>',
        );
      });

      test('a single heading node with a child text node', async () => {
        const editor = createTestEditor();

        const element = document.createElement('div');

        editor.setRootElement(element);

        await editor.update(() => {
          const root = $getRoot();

          const paragraph = $createParagraphNode();
          root.append(paragraph);

          $setAnchorPoint({
            key: paragraph.getKey(),
            offset: 0,
            type: 'element',
          });

          $setFocusPoint({
            key: paragraph.getKey(),
            offset: 0,
            type: 'element',
          });

          const heading = $createHeadingNode('h1');
          const child = $createTextNode('foo');

          heading.append(child);

          const selection = $getSelection();

          if (!$isRangeSelection(selection)) {
            return;
          }
          selection.insertNodes([heading]);
        });

        expect(element.innerHTML).toBe(
          '<h1 dir="auto"><span data-lexical-text="true">foo</span></h1>',
        );
      });
    });

    describe('with a paragraph node selected on some existing text', () => {
      test('a single text node', async () => {
        const editor = createTestEditor();

        const element = document.createElement('div');

        editor.setRootElement(element);

        await editor.update(() => {
          const root = $getRoot();

          const paragraph = $createParagraphNode();
          const text = $createTextNode('Existing text...');

          paragraph.append(text);
          root.append(paragraph);

          $setAnchorPoint({
            key: text.getKey(),
            offset: 16,
            type: 'text',
          });

          $setFocusPoint({
            key: text.getKey(),
            offset: 16,
            type: 'text',
          });

          const selection = $getSelection();

          if (!$isRangeSelection(selection)) {
            return;
          }
          selection.insertNodes([$createTextNode('foo')]);
        });

        expect(element.innerHTML).toBe(
          '<p dir="auto"><span data-lexical-text="true">Existing text...foo</span></p>',
        );
      });

      test('two text nodes', async () => {
        const editor = createTestEditor();

        const element = document.createElement('div');

        editor.setRootElement(element);

        await editor.update(() => {
          const root = $getRoot();

          const paragraph = $createParagraphNode();
          const text = $createTextNode('Existing text...');

          paragraph.append(text);
          root.append(paragraph);

          $setAnchorPoint({
            key: text.getKey(),
            offset: 16,
            type: 'text',
          });

          $setFocusPoint({
            key: text.getKey(),
            offset: 16,
            type: 'text',
          });

          const selection = $getSelection();

          if (!$isRangeSelection(selection)) {
            return;
          }

          selection.insertNodes([
            $createTextNode('foo'),
            $createTextNode('bar'),
          ]);
        });

        expect(element.innerHTML).toBe(
          '<p dir="auto"><span data-lexical-text="true">Existing text...foobar</span></p>',
        );
      });

      test('a single heading node with a child text node', async () => {
        const editor = createTestEditor();

        const element = document.createElement('div');

        editor.setRootElement(element);

        await editor.update(() => {
          const root = $getRoot();

          const paragraph = $createParagraphNode();
          const text = $createTextNode('Existing text...');

          paragraph.append(text);
          root.append(paragraph);

          $setAnchorPoint({
            key: text.getKey(),
            offset: 16,
            type: 'text',
          });

          $setFocusPoint({
            key: text.getKey(),
            offset: 16,
            type: 'text',
          });

          const heading = $createHeadingNode('h1');
          const child = $createTextNode('foo');

          heading.append(child);

          const selection = $getSelection();

          if (!$isRangeSelection(selection)) {
            return;
          }

          selection.insertNodes([heading]);
        });

        expect(element.innerHTML).toBe(
          '<p dir="auto"><span data-lexical-text="true">Existing text...foo</span></p>',
        );
      });

      test('a paragraph with a child text and a child italic text and a child text', async () => {
        const editor = createTestEditor();

        const element = document.createElement('div');

        editor.setRootElement(element);

        await editor.update(() => {
          const root = $getRoot();

          const paragraph = $createParagraphNode();
          const text = $createTextNode('AE');

          paragraph.append(text);
          root.append(paragraph);

          $setAnchorPoint({
            key: text.getKey(),
            offset: 1,
            type: 'text',
          });

          $setFocusPoint({
            key: text.getKey(),
            offset: 1,
            type: 'text',
          });

          const insertedParagraph = $createParagraphNode();
          const insertedTextB = $createTextNode('B');
          const insertedTextC = $createTextNode('C');
          const insertedTextD = $createTextNode('D');

          insertedTextC.toggleFormat('italic');

          insertedParagraph.append(insertedTextB, insertedTextC, insertedTextD);

          const selection = $getSelection();

          if (!$isRangeSelection(selection)) {
            return;
          }

          selection.insertNodes([insertedParagraph]);

          expect(selection.anchor).toEqual(
            expect.objectContaining({
              key: paragraph
                .getChildAtIndex(paragraph.getChildrenSize() - 2)!
                .getKey(),
              offset: 1,
              type: 'text',
            }),
          );

          expect(selection.focus).toEqual(
            expect.objectContaining({
              key: paragraph
                .getChildAtIndex(paragraph.getChildrenSize() - 2)!
                .getKey(),
              offset: 1,
              type: 'text',
            }),
          );
        });

        expect(element.innerHTML).toBe(
          '<p dir="auto"><span data-lexical-text="true">AB</span><em data-lexical-text="true">C</em><span data-lexical-text="true">DE</span></p>',
        );
      });
    });

    describe('with a fully-selected text node', () => {
      test('a single text node', async () => {
        const editor = createTestEditor();

        const element = document.createElement('div');

        editor.setRootElement(element);

        await editor.update(() => {
          const root = $getRoot();

          const paragraph = $createParagraphNode();
          root.append(paragraph);

          const text = $createTextNode('Existing text...');
          paragraph.append(text);

          $setAnchorPoint({
            key: text.getKey(),
            offset: 0,
            type: 'text',
          });

          $setFocusPoint({
            key: text.getKey(),
            offset: 'Existing text...'.length,
            type: 'text',
          });

          const selection = $getSelection();

          if (!$isRangeSelection(selection)) {
            return;
          }
          selection.insertNodes([$createTextNode('foo')]);
        });

        expect(element.innerHTML).toBe(
          '<p dir="auto"><span data-lexical-text="true">foo</span></p>',
        );
      });
    });

    describe('with a fully-selected text node followed by an inline element', () => {
      test('a single text node', async () => {
        const editor = createTestEditor();

        const element = document.createElement('div');

        editor.setRootElement(element);

        await editor.update(() => {
          const root = $getRoot();

          const paragraph = $createParagraphNode();
          root.append(paragraph);

          const text = $createTextNode('Existing text...');
          paragraph.append(text);

          const link = $createLinkNode('https://');
          link.append($createTextNode('link'));
          paragraph.append(link);

          $setAnchorPoint({
            key: text.getKey(),
            offset: 0,
            type: 'text',
          });

          $setFocusPoint({
            key: text.getKey(),
            offset: 'Existing text...'.length,
            type: 'text',
          });

          const selection = $getSelection();

          if (!$isRangeSelection(selection)) {
            return;
          }
          selection.insertNodes([$createTextNode('foo')]);
        });

        expect(element.innerHTML).toBe(
          '<p dir="auto"><span data-lexical-text="true">foo</span><a href="https://"><span data-lexical-text="true">link</span></a></p>',
        );
      });
    });

    describe('with a fully-selected text node preceded by an inline element', () => {
      test('a single text node', async () => {
        const editor = createTestEditor();

        const element = document.createElement('div');

        editor.setRootElement(element);

        await editor.update(() => {
          const root = $getRoot();

          const paragraph = $createParagraphNode();
          root.append(paragraph);

          const link = $createLinkNode('https://');
          link.append($createTextNode('link'));
          paragraph.append(link);

          const text = $createTextNode('Existing text...');
          paragraph.append(text);

          $setAnchorPoint({
            key: text.getKey(),
            offset: 0,
            type: 'text',
          });

          $setFocusPoint({
            key: text.getKey(),
            offset: 'Existing text...'.length,
            type: 'text',
          });

          const selection = $getSelection();

          if (!$isRangeSelection(selection)) {
            return;
          }
          selection.insertNodes([$createTextNode('foo')]);
        });

        expect(element.innerHTML).toBe(
          '<p dir="auto"><a href="https://"><span data-lexical-text="true">link</span></a><span data-lexical-text="true">foo</span></p>',
        );
      });
    });

    test('can insert a linebreak node before an inline element node', async () => {
      const editor = createTestEditor();
      const element = document.createElement('div');
      editor.setRootElement(element);

      await editor.update(() => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        root.append(paragraph);
        const link = $createLinkNode('https://lexical.dev/');
        paragraph.append(link);
        const text = $createTextNode('Lexical');
        link.append(text);
        text.select(0, 0);

        $insertNodes([$createLineBreakNode()]);
      });

      // TODO #5109 ElementNode should have a way to control when other nodes can be inserted inside
      expect(element.innerHTML).toBe(
        '<p dir="auto"><br><a href="https://lexical.dev/"><span data-lexical-text="true">Lexical</span></a></p>',
      );
    });
  });

  describe('can insert block element nodes correctly', () => {
    describe('with a fully-selected text node', () => {
      test('a paragraph node', async () => {
        const editor = createTestEditor();

        const element = document.createElement('div');

        editor.setRootElement(element);

        await editor.update(() => {
          const root = $getRoot();

          const paragraph = $createParagraphNode();
          root.append(paragraph);

          const text = $createTextNode('Existing text...');
          paragraph.append(text);

          $setAnchorPoint({
            key: text.getKey(),
            offset: 0,
            type: 'text',
          });

          $setFocusPoint({
            key: text.getKey(),
            offset: 'Existing text...'.length,
            type: 'text',
          });

          const paragraphToInsert = $createParagraphNode();
          paragraphToInsert.append($createTextNode('foo'));

          const selection = $getSelection();

          if (!$isRangeSelection(selection)) {
            return;
          }
          selection.insertNodes([paragraphToInsert]);
        });

        expect(element.innerHTML).toBe(
          '<p dir="auto"><span data-lexical-text="true">foo</span></p>',
        );
      });
    });

    describe('with a fully-selected text node followed by an inline element', () => {
      test('a paragraph node', async () => {
        const editor = createTestEditor();

        const element = document.createElement('div');

        editor.setRootElement(element);

        await editor.update(() => {
          const root = $getRoot();

          const paragraph = $createParagraphNode();
          root.append(paragraph);

          const text = $createTextNode('Existing text...');
          paragraph.append(text);

          const link = $createLinkNode('https://');
          link.append($createTextNode('link'));
          paragraph.append(link);

          $setAnchorPoint({
            key: text.getKey(),
            offset: 0,
            type: 'text',
          });

          $setFocusPoint({
            key: text.getKey(),
            offset: 'Existing text...'.length,
            type: 'text',
          });

          const paragraphToInsert = $createParagraphNode();
          paragraphToInsert.append($createTextNode('foo'));

          const selection = $getSelection();

          if (!$isRangeSelection(selection)) {
            return;
          }
          selection.insertNodes([paragraphToInsert]);
        });

        expect(element.innerHTML).toBe(
          '<p dir="auto"><span data-lexical-text="true">foo</span><a href="https://"><span data-lexical-text="true">link</span></a></p>',
        );
      });
    });

    describe('with a fully-selected text node preceded by an inline element', () => {
      test('a paragraph node', async () => {
        const editor = createTestEditor();

        const element = document.createElement('div');

        editor.setRootElement(element);

        await editor.update(() => {
          const root = $getRoot();

          const paragraph = $createParagraphNode();
          root.append(paragraph);

          const link = $createLinkNode('https://');
          link.append($createTextNode('link'));
          paragraph.append(link);

          const text = $createTextNode('Existing text...');
          paragraph.append(text);

          $setAnchorPoint({
            key: text.getKey(),
            offset: 0,
            type: 'text',
          });

          $setFocusPoint({
            key: text.getKey(),
            offset: 'Existing text...'.length,
            type: 'text',
          });

          const paragraphToInsert = $createParagraphNode();
          paragraphToInsert.append($createTextNode('foo'));

          const selection = $getSelection();

          if (!$isRangeSelection(selection)) {
            return;
          }
          selection.insertNodes([paragraphToInsert]);
        });

        expect(element.innerHTML).toBe(
          '<p dir="auto"><a href="https://"><span data-lexical-text="true">link</span></a><span data-lexical-text="true">foo</span></p>',
        );
      });
    });

    test('Can insert link into empty paragraph', async () => {
      const editor = createTestEditor();
      const element = document.createElement('div');
      editor.setRootElement(element);

      await editor.update(() => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        root.append(paragraph);
        const linkNode = $createLinkNode('https://lexical.dev');
        const linkTextNode = $createTextNode('Lexical');
        linkNode.append(linkTextNode);
        $insertNodes([linkNode]);
      });
      expect(element.innerHTML).toBe(
        '<p dir="auto"><a href="https://lexical.dev"><span data-lexical-text="true">Lexical</span></a></p>',
      );
    });

    test('Can insert link into empty paragraph (2)', async () => {
      const editor = createTestEditor();
      const element = document.createElement('div');
      editor.setRootElement(element);

      await editor.update(() => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        root.append(paragraph);
        const linkNode = $createLinkNode('https://lexical.dev');
        const linkTextNode = $createTextNode('Lexical');
        linkNode.append(linkTextNode);
        const textNode2 = $createTextNode('...');
        $insertNodes([linkNode, textNode2]);
      });
      expect(element.innerHTML).toBe(
        '<p dir="auto"><a href="https://lexical.dev"><span data-lexical-text="true">Lexical</span></a><span data-lexical-text="true">...</span></p>',
      );
    });

    test('Can insert an ElementNode after ShadowRoot', async () => {
      const editor = createTestEditor();
      const element = document.createElement('div');
      editor.setRootElement(element);

      await editor.update(() => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        root.append(paragraph);
        paragraph.selectStart();
        const element1 = $createTestShadowRootNode();
        const element2 = $createTestElementNode();
        $insertNodes([element1, element2]);
      });
      expect([
        '<div dir="auto"><br data-lexical-managed-linebreak="true"></div><div dir="auto"><br data-lexical-managed-linebreak="true"></div>',
        '<div dir="auto"><br data-lexical-managed-linebreak="true"></div><p dir="auto"><br data-lexical-managed-linebreak="true"></p>',
      ]).toContain(element.innerHTML);
    });
  });
});

describe('extract', () => {
  test('Should return the selected node when collapsed on a TextNode', async () => {
    const editor = createTestEditor();

    const element = document.createElement('div');

    editor.setRootElement(element);

    await editor.update(() => {
      const root = $getRoot();

      const paragraph = $createParagraphNode();
      const text = $createTextNode('Existing text...');

      paragraph.append(text);
      root.append(paragraph);

      $setAnchorPoint({
        key: text.getKey(),
        offset: 16,
        type: 'text',
      });

      $setFocusPoint({
        key: text.getKey(),
        offset: 16,
        type: 'text',
      });

      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBeTruthy();

      expect(selection!.extract()).toEqual([text]);
    });
  });
});

describe('insertNodes', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('can insert element next to top level decorator node', async () => {
    const editor = createTestEditor();
    const element = document.createElement('div');
    editor.setRootElement(element);

    vi.spyOn(TestDecoratorNode.prototype, 'isInline').mockReturnValue(false);

    await editor.update(() => {
      $getRoot().append(
        $createParagraphNode(),
        $createTestDecoratorNode(),
        $createParagraphNode().append($createTextNode('Text after')),
      );
    });

    await editor.update(() => {
      const selectionNode = $getRoot().getFirstChild();
      invariant($isElementNode(selectionNode));
      const selection = selectionNode.select();
      selection.insertNodes([
        $createParagraphNode().append($createTextNode('Text before')),
      ]);
    });

    expect(element.innerHTML).toBe(
      '<p dir="auto"><span data-lexical-text="true">Text before</span></p>' +
        '<span data-lexical-decorator="true" contenteditable="false"></span>' +
        '<p dir="auto"><span data-lexical-text="true">Text after</span></p>',
    );
  });

  it('can insert when previous selection was null', async () => {
    const editor = createTestHeadlessEditor();
    await editor.update(() => {
      const selection = $createRangeSelection();
      selection.anchor.set('root', 0, 'element');
      selection.focus.set('root', 0, 'element');

      selection.insertNodes([
        $createParagraphNode().append($createTextNode('Text')),
      ]);

      expect($getRoot().getTextContent()).toBe('Text');

      $setSelection(null);
    });
    await editor.update(() => {
      const selection = $createRangeSelection();
      const text = $getRoot().getLastDescendant()!;
      selection.anchor.set(text.getKey(), 0, 'text');
      selection.focus.set(text.getKey(), 0, 'text');

      selection.insertNodes([
        $createParagraphNode().append($createTextNode('Before ')),
      ]);

      expect($getRoot().getTextContent()).toBe('Before Text');
    });
  });

  it('can insert when before empty text node', async () => {
    const editor = createTestEditor();
    const element = document.createElement('div');
    editor.setRootElement(element);

    await editor.update(() => {
      // Empty text node to test empty text split
      const emptyTextNode = $createTextNode('');
      $getRoot().append(
        $createParagraphNode().append(emptyTextNode, $createTextNode('text')),
      );
      emptyTextNode.select(0, 0);
      const selection = $getSelection()!;
      expect($isRangeSelection(selection)).toBeTruthy();
      selection.insertNodes([$createTextNode('foo')]);

      expect($getRoot().getTextContent()).toBe('footext');
    });
  });

  it('last node is LineBreakNode', async () => {
    const editor = createTestEditor();
    const element = document.createElement('div');
    editor.setRootElement(element);

    await editor.update(() => {
      // Empty text node to test empty text split
      const paragraph = $createParagraphNode();
      $getRoot().append(paragraph);
      const selection = paragraph.select();
      expect($isRangeSelection(selection)).toBeTruthy();

      const newHeading = $createHeadingNode('h1').append(
        $createTextNode('heading'),
      );
      selection.insertNodes([newHeading, $createLineBreakNode()]);
    });
    editor.read('latest', () => {
      expect(element.innerHTML).toBe(
        // the lone trailing LineBreakNode collapses to an empty paragraph,
        // rendered with only the managed linebreak
        '<h1 dir="auto"><span data-lexical-text="true">heading</span></h1><p dir="auto"><br data-lexical-managed-linebreak="true"></p>',
      );
      const selectedNode = ($getSelection() as RangeSelection).anchor.getNode();
      expect($isParagraphNode(selectedNode)).toBeTruthy();
      expect($isHeadingNode(selectedNode.getPreviousSibling())).toBeTruthy();
    });
  });
});

describe('$patchStyleText', () => {
  test('can patch a selection anchored to the end of a TextNode before an inline element', async () => {
    const editor = createTestEditor();
    const element = document.createElement('div');
    editor.setRootElement(element);

    await editor.update(() => {
      const root = $getRoot();

      const paragraph = $createParagraphWithNodes(editor, [
        {
          key: 'a',
          mergeable: false,
          text: 'a',
        },
        {
          key: 'b',
          mergeable: false,
          text: 'b',
        },
      ]);

      root.append(paragraph);

      const link = $createLinkNode('https://');
      link.append($createTextNode('link'));

      const a = $getNodeByKey('a')!;
      a.insertAfter(link);

      $setAnchorPoint({
        key: 'a',
        offset: 1,
        type: 'text',
      });
      $setFocusPoint({
        key: 'b',
        offset: 1,
        type: 'text',
      });

      const selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        return;
      }
      $patchStyleText(selection, {'text-emphasis': 'filled'});
    });

    expect(element.innerHTML).toBe(
      '<p dir="auto"><span data-lexical-text="true">a</span>' +
        '<a href="https://">' +
        '<span style="text-emphasis: filled;" data-lexical-text="true">link</span>' +
        '</a>' +
        '<span style="text-emphasis: filled;" data-lexical-text="true">b</span></p>',
    );
  });

  test('can patch a selection anchored to the end of a TextNode at the end of a paragraph', async () => {
    const editor = createTestEditor();
    const element = document.createElement('div');
    editor.setRootElement(element);

    await editor.update(() => {
      const root = $getRoot();

      const paragraph1 = $createParagraphWithNodes(editor, [
        {
          key: 'a',
          mergeable: false,
          text: 'a',
        },
      ]);
      const paragraph2 = $createParagraphWithNodes(editor, [
        {
          key: 'b',
          mergeable: false,
          text: 'b',
        },
      ]);

      root.append(paragraph1);
      root.append(paragraph2);

      $setAnchorPoint({
        key: 'a',
        offset: 1,
        type: 'text',
      });
      $setFocusPoint({
        key: 'b',
        offset: 1,
        type: 'text',
      });

      const selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        return;
      }
      $patchStyleText(selection, {'text-emphasis': 'filled'});
    });

    expect(element.innerHTML).toBe(
      '<p dir="auto"><span data-lexical-text="true">a</span></p>' +
        '<p dir="auto"><span style="text-emphasis: filled;" data-lexical-text="true">b</span></p>',
    );
  });

  test('can patch a selection that ends on an element', async () => {
    const editor = createTestEditor();
    const element = document.createElement('div');
    editor.setRootElement(element);

    await editor.update(() => {
      const root = $getRoot();

      const paragraph = $createParagraphWithNodes(editor, [
        {
          key: 'a',
          mergeable: false,
          text: 'a',
        },
      ]);

      root.append(paragraph);

      const link = $createLinkNode('https://');
      link.append($createTextNode('link'));

      const a = $getNodeByKey('a')!;
      a.insertAfter(link);

      $setAnchorPoint({
        key: 'a',
        offset: 0,
        type: 'text',
      });
      // Select to end of the link _element_
      $setFocusPoint({
        key: link.getKey(),
        offset: 1,
        type: 'element',
      });

      const selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        return;
      }
      $patchStyleText(selection, {'text-emphasis': 'filled'});
    });

    expect(element.innerHTML).toBe(
      '<p dir="auto">' +
        '<span style="text-emphasis: filled;" data-lexical-text="true">a</span>' +
        '<a href="https://">' +
        '<span style="text-emphasis: filled;" data-lexical-text="true">link</span>' +
        '</a>' +
        '</p>',
    );
  });

  test('can patch a reversed selection that ends on an element', async () => {
    const editor = createTestEditor();
    const element = document.createElement('div');
    editor.setRootElement(element);

    await editor.update(() => {
      const root = $getRoot();

      const paragraph = $createParagraphWithNodes(editor, [
        {
          key: 'a',
          mergeable: false,
          text: 'a',
        },
      ]);

      root.append(paragraph);

      const link = $createLinkNode('https://');
      link.append($createTextNode('link'));

      const a = $getNodeByKey('a')!;
      a.insertAfter(link);

      // Select from the end of the link _element_
      $setAnchorPoint({
        key: link.getKey(),
        offset: 1,
        type: 'element',
      });
      $setFocusPoint({
        key: 'a',
        offset: 0,
        type: 'text',
      });

      const selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        return;
      }
      $patchStyleText(selection, {'text-emphasis': 'filled'});
    });

    expect(element.innerHTML).toBe(
      '<p dir="auto">' +
        '<span style="text-emphasis: filled;" data-lexical-text="true">a</span>' +
        '<a href="https://">' +
        '<span style="text-emphasis: filled;" data-lexical-text="true">link</span>' +
        '</a>' +
        '</p>',
    );
  });

  test('can patch a selection that starts and ends on an element', async () => {
    const editor = createTestEditor();
    const element = document.createElement('div');
    editor.setRootElement(element);

    await editor.update(() => {
      const root = $getRoot();

      const paragraph = $createParagraphNode();
      root.append(paragraph);

      const link = $createLinkNode('https://');
      link.append($createTextNode('link'));
      paragraph.append(link);

      $setAnchorPoint({
        key: link.getKey(),
        offset: 0,
        type: 'element',
      });
      $setFocusPoint({
        key: link.getKey(),
        offset: 1,
        type: 'element',
      });

      const selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        return;
      }
      $patchStyleText(selection, {'text-emphasis': 'filled'});
    });

    expect(element.innerHTML).toBe(
      '<p dir="auto">' +
        '<a href="https://">' +
        '<span style="text-emphasis: filled;" data-lexical-text="true">link</span>' +
        '</a>' +
        '</p>',
    );
  });

  test('can clear a style', async () => {
    const editor = createTestEditor();
    const element = document.createElement('div');
    editor.setRootElement(element);

    await editor.update(() => {
      const root = $getRoot();

      const paragraph = $createParagraphNode();
      root.append(paragraph);

      const text = $createTextNode('text');
      paragraph.append(text);

      $setAnchorPoint({
        key: text.getKey(),
        offset: 0,
        type: 'text',
      });
      $setFocusPoint({
        key: text.getKey(),
        offset: text.getTextContentSize(),
        type: 'text',
      });

      const selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        return;
      }
      $patchStyleText(selection, {'text-emphasis': 'filled'});
      $patchStyleText(selection, {'text-emphasis': null});
    });

    expect(element.innerHTML).toBe(
      '<p dir="auto"><span data-lexical-text="true">text</span></p>',
    );
  });

  test('can toggle a style on a collapsed selection', async () => {
    const editor = createTestEditor();
    const element = document.createElement('div');
    editor.setRootElement(element);

    await editor.update(() => {
      const root = $getRoot();

      const paragraph = $createParagraphNode();
      root.append(paragraph);

      const text = $createTextNode('text');
      paragraph.append(text);

      $setAnchorPoint({
        key: text.getKey(),
        offset: 0,
        type: 'text',
      });
      $setFocusPoint({
        key: text.getKey(),
        offset: 0,
        type: 'text',
      });

      const selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        return;
      }
      $patchStyleText(selection, {'text-emphasis': 'filled'});

      expect(
        $getSelectionStyleValueForProperty(selection, 'text-emphasis', ''),
      ).toEqual('filled');

      $patchStyleText(selection, {'text-emphasis': null});

      expect(
        $getSelectionStyleValueForProperty(selection, 'text-emphasis', ''),
      ).toEqual('');

      $patchStyleText(selection, {'text-emphasis': 'filled'});

      expect(
        $getSelectionStyleValueForProperty(selection, 'text-emphasis', ''),
      ).toEqual('filled');
    });
  });

  test('updates cached styles when setting on a collapsed selection', async () => {
    const editor = createTestEditor();
    const element = document.createElement('div');
    editor.setRootElement(element);

    await editor.update(() => {
      const root = $getRoot();

      const paragraph = $createParagraphNode();
      root.append(paragraph);

      const text = $createTextNode('text');
      paragraph.append(text);

      $setAnchorPoint({
        key: text.getKey(),
        offset: 0,
        type: 'text',
      });
      $setFocusPoint({
        key: text.getKey(),
        offset: 0,
        type: 'text',
      });

      // First fetch the initial style -- this will cause the CSS cache to be
      // populated with an empty string pointing to an empty style object.
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        return;
      }
      $getSelectionStyleValueForProperty(selection, 'color', '');

      // Now when we set the style, we should _not_ touch the previously created
      // empty style object, but create a new one instead.
      $patchStyleText(selection, {color: 'red'});

      // We can check that result by clearing the style and re-querying it.
      ($getSelection() as RangeSelection).setStyle('');

      const color = $getSelectionStyleValueForProperty(
        $getSelection() as RangeSelection,
        'color',
        '',
      );
      expect(color).toEqual('');
    });
  });

  test('$getSelectionStyleValueForProperty returns consistent value regardless of selection direction', async () => {
    const editor = createTestEditor();
    const element = document.createElement('div');
    editor.setRootElement(element);

    await editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      root.append(paragraph);

      const unstyled = $createTextNode('plain');
      const styled = $createTextNode('colored');
      styled.setStyle('color: red');

      paragraph.append(unstyled);
      paragraph.append(styled);

      // Forward selection: unstyled -> styled
      $setAnchorPoint({
        key: unstyled.getKey(),
        offset: 0,
        type: 'text',
      });
      $setFocusPoint({
        key: styled.getKey(),
        offset: 'colored'.length,
        type: 'text',
      });

      const forwardValue = $getSelectionStyleValueForProperty(
        $getSelection() as RangeSelection,
        'color',
        '',
      );

      // Backward selection: styled -> unstyled
      $setAnchorPoint({
        key: styled.getKey(),
        offset: 'colored'.length,
        type: 'text',
      });
      $setFocusPoint({
        key: unstyled.getKey(),
        offset: 0,
        type: 'text',
      });

      const backwardValue = $getSelectionStyleValueForProperty(
        $getSelection() as RangeSelection,
        'color',
        '',
      );

      expect(forwardValue).toEqual('');
      expect(backwardValue).toEqual('');
      expect(forwardValue).toEqual(backwardValue);
    });
  });

  test('$getSelectionStyleValueForProperty ignores nodes with zero characters selected at boundaries', async () => {
    const editor = createTestEditor();
    const element = document.createElement('div');
    editor.setRootElement(element);

    await editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      root.append(paragraph);

      const styledA = $createTextNode('aaa');
      styledA.setStyle('color: red');
      const styledB = $createTextNode('bbb');
      styledB.setStyle('color: red');
      const different = $createTextNode('ccc');
      different.setStyle('color: blue');

      paragraph.append(styledA);
      paragraph.append(styledB);
      paragraph.append(different);

      // Select from end of styledA to start of different
      // styledA has 0 chars selected (offset at end), different has 0 chars (offset 0)
      // only styledB is fully selected
      $setAnchorPoint({
        key: styledA.getKey(),
        offset: 'aaa'.length,
        type: 'text',
      });
      $setFocusPoint({
        key: different.getKey(),
        offset: 0,
        type: 'text',
      });

      const value = $getSelectionStyleValueForProperty(
        $getSelection() as RangeSelection,
        'color',
        '',
      );

      expect(value).toEqual('red');
    });
  });

  test.each<TextModeType>(['token', 'segmented'])(
    'can update style of text node that is in %s mode',
    async mode => {
      const editor = createTestEditor();

      const element = document.createElement('div');
      editor.setRootElement(element);

      await editor.update(() => {
        const root = $getRoot();

        const paragraph = $createParagraphNode();
        root.append(paragraph);

        const text = $createTextNode('first').setFormat('bold');
        paragraph.append(text);

        const textInMode = $createTextNode('second').setMode(mode);
        paragraph.append(textInMode);

        $setAnchorPoint({
          key: text.getKey(),
          offset: 'fir'.length,
          type: 'text',
        });

        $setFocusPoint({
          key: textInMode.getKey(),
          offset: 'sec'.length,
          type: 'text',
        });

        const selection = $getSelection();
        $patchStyleText(selection!, {'font-size': '15px'});
      });

      expect(element.innerHTML).toBe(
        '<p dir="auto">' +
          '<strong data-lexical-text="true">fir</strong>' +
          '<strong style="font-size: 15px;" data-lexical-text="true">st</strong>' +
          '<span style="font-size: 15px;" data-lexical-text="true">second</span>' +
          '</p>',
      );
    },
  );

  test('preserve backward selection when changing style of 2 different text nodes', async () => {
    const editor = createTestEditor();

    const element = document.createElement('div');

    editor.setRootElement(element);

    editor.update(() => {
      const root = $getRoot();

      const paragraph = $createParagraphNode();
      root.append(paragraph);

      const firstText = $createTextNode('first ').setFormat('bold');
      paragraph.append(firstText);

      const secondText = $createTextNode('second').setFormat('italic');
      paragraph.append(secondText);

      $setAnchorPoint({
        key: secondText.getKey(),
        offset: 'sec'.length,
        type: 'text',
      });

      $setFocusPoint({
        key: firstText.getKey(),
        offset: 'fir'.length,
        type: 'text',
      });

      const selection = $getSelection()!;

      $patchStyleText(selection, {'font-size': '11px'});

      const [newAnchor, newFocus] = selection.getStartEndPoints()!;

      const newAnchorNode: LexicalNode = newAnchor.getNode();
      expect(newAnchorNode.getTextContent()).toBe('sec');
      expect(newAnchor.offset).toBe('sec'.length);

      const newFocusNode: LexicalNode = newFocus.getNode();
      expect(newFocusNode.getTextContent()).toBe('st ');
      expect(newFocus.offset).toBe(0);
    });
  });

  test('applies a function-valued patch exactly once to an empty element', async () => {
    const editor = createTestEditor();

    const element = document.createElement('div');

    editor.setRootElement(element);

    let paragraphStyle = '';
    let selectionStyle = '';

    await editor.update(() => {
      const root = $getRoot();

      const paragraph = $createParagraphNode();
      root.append(paragraph);
      paragraph.selectStart();

      const selection = $getSelection()!;

      // Mirrors the playground font-size +/- buttons, which patch with a
      // function of the previous value rather than a constant.
      $patchStyleText(selection, {
        'font-size': currentValue => {
          const size = parseInt(currentValue || '', 10);
          return `${(Number.isNaN(size) ? 16 : size) + 2}px`;
        },
      });

      selectionStyle = ($getSelection() as RangeSelection).style;
      paragraphStyle = paragraph.getTextStyle();
    });

    expect(selectionStyle).toBe('font-size: 18px;');
    expect(paragraphStyle).toBe('font-size: 18px;');
  });
});
