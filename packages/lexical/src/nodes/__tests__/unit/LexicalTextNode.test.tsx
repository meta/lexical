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
  $getSelection,
  $getState,
  $isElementNode,
  $isNodeSelection,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $setState,
  createState,
  IS_BOLD,
  IS_CODE,
  IS_HIGHLIGHT,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  IS_SUBSCRIPT,
  IS_SUPERSCRIPT,
  IS_UNDERLINE,
  type LexicalEditor,
  type TextFormatType,
  type TextModeType,
  type TextNode,
} from 'lexical';
import * as React from 'react';
import {act, createRef, useEffect, useMemo} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

import {
  $assertNodeType,
  $createTestSegmentedNode,
  createTestEditor,
} from '../../../__tests__/utils';
import {
  IS_CAPITALIZE,
  IS_LOWERCASE,
  IS_UPPERCASE,
} from '../../../LexicalConstants';
import {
  $getCompositionKey,
  $setCompositionKey,
  getEditorStateTextContent,
} from '../../../LexicalUtils';

const editorConfig = Object.freeze({
  namespace: '',
  theme: {
    text: {
      bold: 'my-bold-class',
      capitalize: 'my-capitalize-class',
      code: 'my-code-class',
      highlight: 'my-highlight-class',
      italic: 'my-italic-class',
      lowercase: 'my-lowercase-class',
      strikethrough: 'my-strikethrough-class',
      underline: 'my-underline-class',
      underlineStrikethrough: 'my-underline-strikethrough-class',
      uppercase: 'my-uppercase-class',
    },
  },
});

describe('LexicalTextNode tests', () => {
  let container: HTMLElement;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);

    await init();
  });
  afterEach(() => {
    document.body.removeChild(container);
    // @ts-ignore
    container = null;
  });

  async function update(fn: () => void) {
    editor.update(fn);
    return Promise.resolve().then();
  }

  function useLexicalEditor(
    rootElementRef: React.RefObject<null | HTMLDivElement>,
  ) {
    const editor = useMemo(() => createTestEditor(editorConfig), []);

    useEffect(() => {
      const rootElement = rootElementRef.current;

      editor.setRootElement(rootElement);
    }, [rootElementRef, editor]);

    return editor;
  }

  let editor: LexicalEditor;

  async function init() {
    const ref = createRef<HTMLDivElement>();

    function TestBase() {
      editor = useLexicalEditor(ref);

      return <div ref={ref} contentEditable={true} />;
    }

    act(() => {
      createRoot(container).render(<TestBase />);
    });

    // Insert initial block
    await update(() => {
      const paragraph = $createParagraphNode();
      const text = $createTextNode();
      text.toggleUnmergeable();
      paragraph.append(text);
      $getRoot().append(paragraph);
    });
  }

  describe('exportJSON()', () => {
    test('should return and object conforming to the expected schema', async () => {
      await update(() => {
        const node = $createTextNode();

        // If you broke this test, you changed the public interface of a
        // serialized Lexical Core Node. Please ensure the correct adapter
        // logic is in place in the corresponding importJSON  method
        // to accommodate these changes.

        expect(node.exportJSON()).toStrictEqual({
          detail: 0,
          format: 0,
          mode: 'normal',
          style: '',
          text: '',
          type: 'text',
          version: 1,
        });
      });
    });
  });

  describe('root.getTextContent()', () => {
    test('writable nodes', async () => {
      let nodeKey: string;

      await update(() => {
        const textNode = $createTextNode('Text');
        nodeKey = textNode.getKey();

        expect(textNode.getTextContent()).toBe('Text');
        expect(textNode.__text).toBe('Text');

        $assertNodeType($getRoot().getFirstChild(), $isElementNode).append(
          textNode,
        );
      });

      expect(
        editor.read('latest', () => {
          const root = $getRoot();
          return root.__cachedText;
        }),
      );
      expect(getEditorStateTextContent(editor.getEditorState(), editor)).toBe(
        'Text',
      );

      // Make sure that the editor content is still set after further reconciliations
      await update(() => {
        $getNodeByKey(nodeKey)!.markDirty();
      });
      expect(getEditorStateTextContent(editor.getEditorState(), editor)).toBe(
        'Text',
      );
    });

    test('prepend node', async () => {
      await update(() => {
        const textNode = $createTextNode('World').toggleUnmergeable();
        $assertNodeType($getRoot().getFirstChild(), $isElementNode).append(
          textNode,
        );
      });

      await update(() => {
        const textNode = $createTextNode('Hello ').toggleUnmergeable();
        const previousTextNode = $assertNodeType(
          $getRoot().getFirstChild(),
          $isElementNode,
        ).getFirstChild()!;
        previousTextNode.insertBefore(textNode);
      });

      expect(getEditorStateTextContent(editor.getEditorState(), editor)).toBe(
        'Hello World',
      );
    });
  });

  describe('setTextContent()', () => {
    test('writable nodes', async () => {
      await update(() => {
        const textNode = $createTextNode('My new text node');
        textNode.setTextContent('My newer text node');

        expect(textNode.getTextContent()).toBe('My newer text node');
      });
    });
  });

  describe.each([
    ['bold', IS_BOLD],
    ['italic', IS_ITALIC],
    ['strikethrough', IS_STRIKETHROUGH],
    ['underline', IS_UNDERLINE],
    ['code', IS_CODE],
    ['subscript', IS_SUBSCRIPT],
    ['superscript', IS_SUPERSCRIPT],
    ['highlight', IS_HIGHLIGHT],
    ['lowercase', IS_LOWERCASE],
    ['uppercase', IS_UPPERCASE],
    ['capitalize', IS_CAPITALIZE],
  ] as const)('%s flag', (formatFlag: TextFormatType, stateFormat: number) => {
    const flagPredicate = (node: TextNode) => node.hasFormat(formatFlag);
    const flagToggle = (node: TextNode) => node.toggleFormat(formatFlag);

    test(`getFormatFlags(${formatFlag})`, async () => {
      await update(() => {
        const root = $getRoot();
        const paragraphNode = $assertNodeType(
          root.getFirstChild(),
          $isParagraphNode,
        );
        const textNode = $assertNodeType(
          paragraphNode.getFirstChild(),
          $isTextNode,
        );
        const newFormat = textNode.getFormatFlags(formatFlag, null);

        expect(newFormat).toBe(stateFormat);

        textNode.setFormat(newFormat);
        const newFormat2 = textNode.getFormatFlags(formatFlag, null);

        expect(newFormat2).toBe(0);
      });
    });

    test(`predicate for ${formatFlag}`, async () => {
      await update(() => {
        const root = $getRoot();
        const paragraphNode = $assertNodeType(
          root.getFirstChild(),
          $isParagraphNode,
        );
        const textNode = $assertNodeType(
          paragraphNode.getFirstChild(),
          $isTextNode,
        );

        textNode.setFormat(stateFormat);

        expect(flagPredicate(textNode)).toBe(true);
      });
    });

    test(`toggling for ${formatFlag}`, async () => {
      // Toggle method hasn't been implemented for this flag.
      if (flagToggle === null) {
        return;
      }

      await update(() => {
        const root = $getRoot();
        const paragraphNode = $assertNodeType(
          root.getFirstChild(),
          $isParagraphNode,
        );
        const textNode = $assertNodeType(
          paragraphNode.getFirstChild(),
          $isTextNode,
        );

        expect(flagPredicate(textNode)).toBe(false);

        flagToggle(textNode);

        expect(flagPredicate(textNode)).toBe(true);

        flagToggle(textNode);

        expect(flagPredicate(textNode)).toBe(false);
      });
    });
  });

  test('setting subscript clears superscript', async () => {
    await update(() => {
      const paragraphNode = $createParagraphNode();
      const textNode = $createTextNode('Hello World');
      paragraphNode.append(textNode);
      $getRoot().append(paragraphNode);
      textNode.toggleFormat('superscript');
      textNode.toggleFormat('subscript');
      expect(textNode.hasFormat('subscript')).toBe(true);
      expect(textNode.hasFormat('superscript')).toBe(false);
    });
  });

  test('setting superscript clears subscript', async () => {
    await update(() => {
      const paragraphNode = $createParagraphNode();
      const textNode = $createTextNode('Hello World');
      paragraphNode.append(textNode);
      $getRoot().append(paragraphNode);
      textNode.toggleFormat('subscript');
      textNode.toggleFormat('superscript');
      expect(textNode.hasFormat('superscript')).toBe(true);
      expect(textNode.hasFormat('subscript')).toBe(false);
    });
  });

  test('clearing subscript does not set superscript', async () => {
    await update(() => {
      const paragraphNode = $createParagraphNode();
      const textNode = $createTextNode('Hello World');
      paragraphNode.append(textNode);
      $getRoot().append(paragraphNode);
      textNode.toggleFormat('subscript');
      textNode.toggleFormat('subscript');
      expect(textNode.hasFormat('subscript')).toBe(false);
      expect(textNode.hasFormat('superscript')).toBe(false);
    });
  });

  test('clearing superscript does not set subscript', async () => {
    await update(() => {
      const paragraphNode = $createParagraphNode();
      const textNode = $createTextNode('Hello World');
      paragraphNode.append(textNode);
      $getRoot().append(paragraphNode);
      textNode.toggleFormat('superscript');
      textNode.toggleFormat('superscript');
      expect(textNode.hasFormat('superscript')).toBe(false);
      expect(textNode.hasFormat('subscript')).toBe(false);
    });
  });

  test('capitalization formats are mutually exclusive', async () => {
    const capitalizationFormats: TextFormatType[] = [
      'lowercase',
      'uppercase',
      'capitalize',
    ];

    await update(() => {
      const paragraphNode = $createParagraphNode();
      const textNode = $createTextNode('Hello World');
      paragraphNode.append(textNode);
      $getRoot().append(paragraphNode);

      // Set each format and ensure that the other formats are cleared
      capitalizationFormats.forEach(formatToSet => {
        textNode.toggleFormat(formatToSet);

        capitalizationFormats
          .filter(format => format !== formatToSet)
          .forEach(format => expect(textNode.hasFormat(format)).toBe(false));

        expect(textNode.hasFormat(formatToSet)).toBe(true);
      });
    });
  });

  test('selectPrevious()', async () => {
    await update(() => {
      const paragraphNode = $createParagraphNode();
      const textNode = $createTextNode('Hello World');
      const textNode2 = $createTextNode('Goodbye Earth');
      paragraphNode.append(textNode, textNode2);
      $getRoot().append(paragraphNode);

      let selection = textNode2.selectPrevious();

      expect(selection.anchor.getNode()).toBe(textNode);
      expect(selection.anchor.offset).toBe(11);
      expect(selection.focus.getNode()).toBe(textNode);
      expect(selection.focus.offset).toBe(11);

      selection = textNode.selectPrevious();

      expect(selection.anchor.getNode()).toBe(paragraphNode);
      expect(selection.anchor.offset).toBe(0);
    });
  });

  test('selectNext()', async () => {
    await update(() => {
      const paragraphNode = $createParagraphNode();
      const textNode = $createTextNode('Hello World');
      const textNode2 = $createTextNode('Goodbye Earth');
      paragraphNode.append(textNode, textNode2);
      $getRoot().append(paragraphNode);
      let selection = textNode.selectNext(1, 3);

      if ($isNodeSelection(selection)) {
        return;
      }

      expect(selection.anchor.getNode()).toBe(textNode2);
      expect(selection.anchor.offset).toBe(1);
      expect(selection.focus.getNode()).toBe(textNode2);
      expect(selection.focus.offset).toBe(3);

      selection = textNode2.selectNext();

      expect(selection.anchor.getNode()).toBe(paragraphNode);
      expect(selection.anchor.offset).toBe(2);
    });
  });

  describe('select()', () => {
    test.each([
      [
        [2, 4],
        [2, 4],
      ],
      [
        [4, 2],
        [4, 2],
      ],
      [
        [undefined, 2],
        [11, 2],
      ],
      [
        [2, undefined],
        [2, 11],
      ],
      [
        [undefined, undefined],
        [11, 11],
      ],
    ])(
      'select(...%p)',
      async (
        [anchorOffset, focusOffset],
        [expectedAnchorOffset, expectedFocusOffset],
      ) => {
        await update(() => {
          const paragraphNode = $createParagraphNode();
          const textNode = $createTextNode('Hello World');
          paragraphNode.append(textNode);
          $getRoot().append(paragraphNode);

          const selection = textNode.select(anchorOffset, focusOffset);

          expect(selection.focus.getNode()).toBe(textNode);
          expect(selection.anchor.offset).toBe(expectedAnchorOffset);
          expect(selection.focus.getNode()).toBe(textNode);
          expect(selection.focus.offset).toBe(expectedFocusOffset);
        });
      },
    );
  });

  describe('splitText()', () => {
    test('convert segmented node into plain text', async () => {
      await update(() => {
        const segmentedNode = $createTestSegmentedNode('Hello World');
        const paragraphNode = $createParagraphNode();
        paragraphNode.append(segmentedNode);

        const [middle, next] = segmentedNode.splitText(5);

        const children = paragraphNode.getAllTextNodes();
        expect(paragraphNode.getTextContent()).toBe('Hello World');
        expect(children[0].isSimpleText()).toBe(true);
        expect(children[0].getTextContent()).toBe('Hello');
        expect(middle).toBe(children[0]);
        expect(next).toBe(children[1]);
      });
    });
    test.each([
      ['a', [], ['a']],
      ['a', [1], ['a']],
      ['a', [5], ['a']],
      ['Hello World', [], ['Hello World']],
      ['Hello World', [3], ['Hel', 'lo World']],
      ['Hello World', [3, 3], ['Hel', 'lo World']],
      ['Hello World', [3, 7], ['Hel', 'lo W', 'orld']],
      ['Hello World', [7, 3], ['Hel', 'lo W', 'orld']],
      ['Hello World', [3, 7, 99], ['Hel', 'lo W', 'orld']],
    ])(
      '"%s" splitText(...%p)',
      async (initialString, splitOffsets, splitStrings) => {
        await update(() => {
          const paragraphNode = $createParagraphNode();
          const textNode = $createTextNode(initialString);
          paragraphNode.append(textNode);

          const splitNodes = textNode.splitText(...splitOffsets);

          expect(paragraphNode.getChildren()).toHaveLength(splitStrings.length);
          expect(splitNodes.map(node => node.getTextContent())).toEqual(
            splitStrings,
          );
        });
      },
    );

    test('splitText moves composition key to last node', async () => {
      await update(() => {
        const paragraphNode = $createParagraphNode();
        const textNode = $createTextNode('12345');
        paragraphNode.append(textNode);
        $setCompositionKey(textNode.getKey());

        const [, splitNode2] = textNode.splitText(1);
        expect($getCompositionKey()).toBe(splitNode2.getKey());
      });
    });

    test.each([
      [
        'Hello',
        [4],
        [3, 3],
        {
          anchorNodeIndex: 0,
          anchorOffset: 3,
          focusNodeIndex: 0,
          focusOffset: 3,
        },
      ],
      [
        'Hello',
        [4],
        [5, 5],
        {
          anchorNodeIndex: 1,
          anchorOffset: 1,
          focusNodeIndex: 1,
          focusOffset: 1,
        },
      ],
      [
        'Hello World',
        [4],
        [2, 7],
        {
          anchorNodeIndex: 0,
          anchorOffset: 2,
          focusNodeIndex: 1,
          focusOffset: 3,
        },
      ],
      [
        'Hello World',
        [4],
        [2, 4],
        {
          anchorNodeIndex: 0,
          anchorOffset: 2,
          focusNodeIndex: 0,
          focusOffset: 4,
        },
      ],
      [
        'Hello World',
        [4],
        [7, 2],
        {
          anchorNodeIndex: 1,
          anchorOffset: 3,
          focusNodeIndex: 0,
          focusOffset: 2,
        },
      ],
      [
        'Hello World',
        [4, 6],
        [2, 9],
        {
          anchorNodeIndex: 0,
          anchorOffset: 2,
          focusNodeIndex: 2,
          focusOffset: 3,
        },
      ],
      [
        'Hello World',
        [4, 6],
        [9, 2],
        {
          anchorNodeIndex: 2,
          anchorOffset: 3,
          focusNodeIndex: 0,
          focusOffset: 2,
        },
      ],
      [
        'Hello World',
        [4, 6],
        [9, 9],
        {
          anchorNodeIndex: 2,
          anchorOffset: 3,
          focusNodeIndex: 2,
          focusOffset: 3,
        },
      ],
    ])(
      '"%s" splitText(...%p) with select(...%p)',
      async (
        initialString,
        splitOffsets,
        selectionOffsets,
        {anchorNodeIndex, anchorOffset, focusNodeIndex, focusOffset},
      ) => {
        await update(() => {
          const paragraphNode = $createParagraphNode();
          const textNode = $createTextNode(initialString);
          paragraphNode.append(textNode);
          $getRoot().append(paragraphNode);

          const selection = textNode.select(...selectionOffsets);
          const childrenNodes = textNode.splitText(...splitOffsets);

          expect(selection.anchor.getNode()).toBe(
            childrenNodes[anchorNodeIndex],
          );
          expect(selection.anchor.offset).toBe(anchorOffset);
          expect(selection.focus.getNode()).toBe(childrenNodes[focusNodeIndex]);
          expect(selection.focus.offset).toBe(focusOffset);
        });
      },
    );

    test('with detached parent', async () => {
      await update(() => {
        const textNode = $createTextNode('foo');
        const splits = textNode.splitText(1, 2);
        expect(splits.map(split => split.getTextContent())).toEqual([
          'f',
          'o',
          'o',
        ]);
      });
    });

    test('copies state to all nodes', async () => {
      await update(() => {
        const textNode = $createTextNode('hello world');
        const state = createState('state', {
          parse: v => v,
          unparse: v => v,
        });
        $setState(textNode, state, 'foo');
        const splits = textNode.splitText(3, 5);
        expect(
          splits.map(split => $getState(split, state)).every(v => v === 'foo'),
        ).toEqual(true);

        // Check that the state value is not aliased to the original node.
        $setState(splits[0], state, 'bar');
        expect($getState(splits[0], state)).toEqual('bar');
        expect($getState(splits[1], state)).toEqual('foo');
        expect($getState(splits[2], state)).toEqual('foo');
      });
    });

    test('copies state to all nodes (segmented)', async () => {
      await update(() => {
        const textNode = $createTestSegmentedNode('hello world');
        const state = createState('state', {
          parse: v => v,
          unparse: v => v,
        });
        $setState(textNode, state, 'foo');
        const splits = textNode.splitText(3, 5);
        expect(
          splits.map(split => $getState(split, state)).every(v => v === 'foo'),
        ).toEqual(true);
      });
    });
  });

  describe('createDOM()', () => {
    test.each([
      ['no formatting', 0, 'My text node', '<span>My text node</span>'],
      [
        'bold',
        IS_BOLD,
        'My text node',
        '<strong class="my-bold-class">My text node</strong>',
      ],
      ['bold + empty', IS_BOLD, '', `<strong class="my-bold-class"></strong>`],
      [
        'underline',
        IS_UNDERLINE,
        'My text node',
        '<span class="my-underline-class">My text node</span>',
      ],
      [
        'strikethrough',
        IS_STRIKETHROUGH,
        'My text node',
        '<span class="my-strikethrough-class">My text node</span>',
      ],
      [
        'highlight',
        IS_HIGHLIGHT,
        'My text node',
        '<mark><span class="my-highlight-class">My text node</span></mark>',
      ],
      [
        'italic',
        IS_ITALIC,
        'My text node',
        '<em class="my-italic-class">My text node</em>',
      ],
      [
        'code',
        IS_CODE,
        'My text node',
        '<code spellcheck="false"><span class="my-code-class">My text node</span></code>',
      ],
      [
        'lowercase',
        IS_LOWERCASE,
        'My text node',
        '<span class="my-lowercase-class">My text node</span>',
      ],
      [
        'uppercase',
        IS_UPPERCASE,
        'My text node',
        '<span class="my-uppercase-class">My text node</span>',
      ],
      [
        'capitalize',
        IS_CAPITALIZE,
        'My text node',
        '<span class="my-capitalize-class">My text node</span>',
      ],
      [
        'underline + strikethrough',
        IS_UNDERLINE | IS_STRIKETHROUGH,
        'My text node',
        '<span class="my-underline-strikethrough-class">' +
          'My text node</span>',
      ],
      [
        'code + italic',
        IS_CODE | IS_ITALIC,
        'My text node',
        '<code spellcheck="false"><em class="my-code-class my-italic-class">My text node</em></code>',
      ],
      [
        'code + underline + strikethrough',
        IS_CODE | IS_UNDERLINE | IS_STRIKETHROUGH,
        'My text node',
        '<code spellcheck="false"><span class="my-underline-strikethrough-class my-code-class">' +
          'My text node</span></code>',
      ],
      [
        'highlight + italic',
        IS_HIGHLIGHT | IS_ITALIC,
        'My text node',
        '<mark><em class="my-highlight-class my-italic-class">My text node</em></mark>',
      ],
      [
        'code + underline + strikethrough + bold + italic',
        IS_CODE | IS_UNDERLINE | IS_STRIKETHROUGH | IS_BOLD | IS_ITALIC,
        'My text node',
        '<code spellcheck="false"><strong class="my-underline-strikethrough-class my-bold-class my-code-class my-italic-class">My text node</strong></code>',
      ],
      [
        'code + underline + strikethrough + bold + italic + highlight + uppercase',
        IS_CODE |
          IS_UNDERLINE |
          IS_STRIKETHROUGH |
          IS_BOLD |
          IS_ITALIC |
          IS_HIGHLIGHT |
          IS_UPPERCASE,
        'My text node',
        '<code spellcheck="false"><strong class="my-underline-strikethrough-class my-bold-class my-code-class my-highlight-class my-italic-class my-uppercase-class">My text node</strong></code>',
      ],
    ])('%s text format type', async (_type, format, contents, expectedHTML) => {
      await update(() => {
        const textNode = $createTextNode(contents);
        textNode.setFormat(format);
        const element = textNode.createDOM(editorConfig);

        expect(element.outerHTML).toBe(expectedHTML);
      });
    });

    test('applies styles with direct DOM property updates', async () => {
      await update(() => {
        const textNode = $createTextNode('My text node');
        textNode.setStyle(
          'color: red; background-color: blue !important; --custom: value;',
        );

        const element = textNode.createDOM(editorConfig);

        expect(element.style.color).toBe('red');
        expect(element.style.backgroundColor).toBe('blue');
        expect(element.style.getPropertyPriority('background-color')).toBe(
          'important',
        );
        expect(element.style.getPropertyValue('--custom')).toBe('value');
      });
    });

    describe('has parent node', () => {
      test.each([
        ['no formatting', 0, 'My text node', '<span>My text node</span>'],
        ['no formatting + empty string', 0, '', `<span></span>`],
      ])(
        '%s text format type',
        async (_type, format, contents, expectedHTML) => {
          await update(() => {
            const paragraphNode = $createParagraphNode();
            const textNode = $createTextNode(contents);
            textNode.setFormat(format);
            paragraphNode.append(textNode);
            const element = textNode.createDOM(editorConfig);

            expect(element.outerHTML).toBe(expectedHTML);
          });
        },
      );
    });
  });

  describe('updateDOM()', () => {
    test.each([
      [
        'different tags',
        {
          format: IS_BOLD,
          mode: 'normal',
          text: 'My text node',
        },
        {
          format: IS_ITALIC,
          mode: 'normal',
          text: 'My text node',
        },
        {
          expectedHTML: null,
          result: true,
        },
      ],
      [
        'no change in tags',
        {
          format: IS_BOLD,
          mode: 'normal',
          text: 'My text node',
        },
        {
          format: IS_BOLD,
          mode: 'normal',
          text: 'My text node',
        },
        {
          expectedHTML: '<strong class="my-bold-class">My text node</strong>',
          result: false,
        },
      ],
      [
        'change in text',
        {
          format: IS_BOLD,
          mode: 'normal',
          text: 'My text node',
        },
        {
          format: IS_BOLD,
          mode: 'normal',
          text: 'My new text node',
        },
        {
          expectedHTML:
            '<strong class="my-bold-class">My new text node</strong>',
          result: false,
        },
      ],
      [
        'removing code block',
        {
          format: IS_CODE | IS_BOLD,
          mode: 'normal',
          text: 'My text node',
        },
        {
          format: IS_BOLD,
          mode: 'normal',
          text: 'My new text node',
        },
        {
          expectedHTML: null,
          result: true,
        },
      ],
    ])(
      '%s',
      async (
        _desc,
        {text: prevText, mode: prevMode, format: prevFormat},
        {text: nextText, mode: nextMode, format: nextFormat},
        {result, expectedHTML},
      ) => {
        await update(() => {
          const prevTextNode = $createTextNode(prevText);
          prevTextNode.setMode(prevMode as TextModeType);
          prevTextNode.setFormat(prevFormat);
          const element = prevTextNode.createDOM(editorConfig);
          const textNode = $createTextNode(nextText);
          textNode.setMode(nextMode as TextModeType);
          textNode.setFormat(nextFormat);

          expect(textNode.updateDOM(prevTextNode, element, editorConfig)).toBe(
            result,
          );
          // Only need to bother about DOM element contents if updateDOM()
          // returns false.
          if (!result) {
            expect(element.outerHTML).toBe(expectedHTML);
          }
        });
      },
    );

    test('updates and removes styles with direct DOM property updates', async () => {
      await update(() => {
        const prevTextNode = $createTextNode('My text node');
        prevTextNode.setStyle('color: red; --custom: value;');

        const element = prevTextNode.createDOM(editorConfig);

        const nextTextNode = $createTextNode('My text node');
        nextTextNode.setStyle('padding: 1px;');

        expect(
          nextTextNode.updateDOM(prevTextNode, element, editorConfig),
        ).toBe(false);
        expect(element.style.color).toBe('');
        expect(element.style.getPropertyValue('--custom')).toBe('');
        expect(element.style.padding).toBe('1px');
      });
    });
  });

  describe('exportDOM()', () => {
    test.each([
      [
        'lowercase format',
        IS_LOWERCASE,
        'Sample Text',
        (element: HTMLElement) => {
          expect(element.style.textTransform).toBe('lowercase');
        },
      ],
      [
        'uppercase format',
        IS_UPPERCASE,
        'Sample Text',
        (element: HTMLElement) => {
          expect(element.style.textTransform).toBe('uppercase');
        },
      ],
      [
        'capitalize format',
        IS_CAPITALIZE,
        'Sample Text',
        (element: HTMLElement) => {
          expect(element.style.textTransform).toBe('capitalize');
        },
      ],
      [
        'combined bold and lowercase format',
        IS_BOLD | IS_LOWERCASE,
        'Sample Text',
        (element: HTMLElement) => {
          expect(element.tagName.toLowerCase()).toBe('b');
          // We need to check the child element for the style
          const childElement = element.firstChild as HTMLElement;
          expect(childElement.style.textTransform).toBe('lowercase');
        },
      ],
    ])('%s', async (_type, format, contents, elementCheck) => {
      await update(() => {
        const textNode = $createTextNode(contents);
        textNode.setFormat(format);
        const {element} = textNode.exportDOM(editor);

        expect(element).not.toBeNull();
        if (element !== null) {
          elementCheck(element as HTMLElement);
        }
      });
    });
  });

  test('mergeWithSibling', async () => {
    await update(() => {
      const paragraph = $assertNodeType(
        $getRoot().getFirstChild(),
        $isElementNode,
      );
      const textNode1 = $createTextNode('1');
      const textNode2 = $createTextNode('2');
      const textNode3 = $createTextNode('3');
      paragraph.append(textNode1, textNode2, textNode3);
      textNode2.select();

      const selection = $getSelection();
      textNode2.mergeWithSibling(textNode1);

      if (!$isRangeSelection(selection)) {
        return;
      }

      expect(selection.anchor.getNode()).toBe(textNode2);
      expect(selection.anchor.offset).toBe(1);
      expect(selection.focus.offset).toBe(1);

      textNode2.mergeWithSibling(textNode3);

      expect(selection.anchor.getNode()).toBe(textNode2);
      expect(selection.anchor.offset).toBe(1);
      expect(selection.focus.offset).toBe(1);
    });

    expect(getEditorStateTextContent(editor.getEditorState(), editor)).toBe(
      '123',
    );
  });
});
