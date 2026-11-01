/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {
  $applyNodeReplacement,
  $copyNode,
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getNodeByKey,
  $getRoot,
  $getState,
  $isTextNode,
  $isTokenOrSegmented,
  $nodesOfType,
  $onUpdate,
  $setCompositionKey,
  $setState,
  createEditor,
  createState,
  ElementNode,
  getParentElement,
  getRegisteredSubtypeMap,
  getTextDirection,
  isExactShortcutMatch,
  isSelectionWithinEditor,
  LineBreakNode,
  ParagraphNode,
  resetRandomKey,
  type SerializedTextNode,
  TabNode,
  TextNode,
} from 'lexical';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from 'vitest';

import {
  $updateTextNodeFromDOMContent,
  emptyFunction,
  generateRandomKey,
  getCachedTypeToNodeMap,
  getCaretRect,
  getStaticNodeConfig,
  isArray,
  iterStaticNodeConfigChain,
  scheduleMicroTask,
  scrollIntoViewIfNeeded,
} from '../../LexicalUtils';
import {$assertNodeType, createTestEditor, initializeUnitTest} from '../utils';

describe('LexicalUtils tests', () => {
  initializeUnitTest(testEnv => {
    test('scheduleMicroTask(): native', async () => {
      vi.resetModules();

      let flag = false;

      scheduleMicroTask(() => {
        flag = true;
      });

      expect(flag).toBe(false);

      await null;

      expect(flag).toBe(true);
    });

    test('scheduleMicroTask(): promise', async () => {
      vi.resetModules();
      const nativeQueueMicrotask = window.queueMicrotask;
      const fn = vi.fn();
      try {
        // @ts-ignore
        window.queueMicrotask = undefined;
        scheduleMicroTask(fn);
      } finally {
        // Reset it before yielding control
        window.queueMicrotask = nativeQueueMicrotask;
      }

      expect(fn).toHaveBeenCalledTimes(0);

      await null;

      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('emptyFunction()', () => {
      expect(emptyFunction).toBeInstanceOf(Function);
      expect(emptyFunction.length).toBe(0);
      expect(emptyFunction()).toBe(undefined);
    });

    test('resetRandomKey()', () => {
      resetRandomKey();
      const key1 = generateRandomKey();
      resetRandomKey();
      const key2 = generateRandomKey();
      expect(typeof key1).toBe('string');
      expect(typeof key2).toBe('string');
      expect(key1).not.toBe('');
      expect(key2).not.toBe('');
      expect(key1).toEqual(key2);
    });

    test('generateRandomKey()', () => {
      const key1 = generateRandomKey();
      const key2 = generateRandomKey();
      expect(typeof key1).toBe('string');
      expect(typeof key2).toBe('string');
      expect(key1).not.toBe('');
      expect(key2).not.toBe('');
      expect(key1).not.toEqual(key2);
    });

    test('isArray()', () => {
      expect(isArray).toBeInstanceOf(Function);
      expect(isArray).toBe(Array.isArray);
    });

    test('isSelectionWithinEditor()', async () => {
      const {editor} = testEnv;
      let textNode: TextNode;

      await editor.update(() => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        textNode = $createTextNode('foo');
        paragraph.append(textNode);
        root.append(paragraph);
      });

      await editor.update(() => {
        const domSelection = window.getSelection()!;

        expect(
          isSelectionWithinEditor(
            editor,
            domSelection.anchorNode,
            domSelection.focusNode,
          ),
        ).toBe(false);

        textNode.select(0, 0);
      });

      await editor.update(() => {
        const domSelection = window.getSelection()!;

        expect(
          isSelectionWithinEditor(
            editor,
            domSelection.anchorNode,
            domSelection.focusNode,
          ),
        ).toBe(true);
      });
    });

    test('getTextDirection()', () => {
      expect(getTextDirection('')).toBe(null);
      expect(getTextDirection(' ')).toBe(null);
      expect(getTextDirection('0')).toBe(null);
      expect(getTextDirection('A')).toBe('ltr');
      expect(getTextDirection('Z')).toBe('ltr');
      expect(getTextDirection('a')).toBe('ltr');
      expect(getTextDirection('z')).toBe('ltr');
      expect(getTextDirection('\u00C0')).toBe('ltr');
      expect(getTextDirection('\u00D6')).toBe('ltr');
      expect(getTextDirection('\u00D8')).toBe('ltr');
      expect(getTextDirection('\u00F6')).toBe('ltr');
      expect(getTextDirection('\u00F8')).toBe('ltr');
      expect(getTextDirection('\u02B8')).toBe('ltr');
      expect(getTextDirection('\u0300')).toBe('ltr');
      expect(getTextDirection('\u0590')).toBe('ltr');
      expect(getTextDirection('\u0800')).toBe('ltr');
      expect(getTextDirection('\u1FFF')).toBe('ltr');
      expect(getTextDirection('\u200E')).toBe('ltr');
      expect(getTextDirection('\u2C00')).toBe('ltr');
      expect(getTextDirection('\uFB1C')).toBe('ltr');
      expect(getTextDirection('\uFE00')).toBe('ltr');
      expect(getTextDirection('\uFE6F')).toBe('ltr');
      expect(getTextDirection('\uFEFD')).toBe('ltr');
      expect(getTextDirection('\uFFFF')).toBe('ltr');
      expect(getTextDirection(`\u0591`)).toBe('rtl');
      expect(getTextDirection(`\u07FF`)).toBe('rtl');
      expect(getTextDirection(`\uFB1D`)).toBe('rtl');
      expect(getTextDirection(`\uFDFD`)).toBe('rtl');
      expect(getTextDirection(`\uFE70`)).toBe('rtl');
      expect(getTextDirection(`\uFEFC`)).toBe('rtl');
    });

    test('isExactShortcutMatch() matches by event.key for single-letter', () => {
      const eventWithoutUppercase = new KeyboardEvent('keydown', {
        code: 'KeyZ',
        ctrlKey: true,
        key: 'z',
      });

      expect(
        isExactShortcutMatch(eventWithoutUppercase, 'z', {ctrlKey: true}),
      ).toBe(true);

      const eventWithUppercase = new KeyboardEvent('keydown', {
        code: 'KeyZ',
        ctrlKey: true,
        key: 'Z',
      });

      expect(
        isExactShortcutMatch(eventWithUppercase, 'z', {ctrlKey: true}),
      ).toBe(true);
    });

    test('isExactShortcutMatch() matches to event.key for ASCII remapped layout (English (US) Dvorak)', () => {
      const eventWithoutUppercase = new KeyboardEvent('keydown', {
        code: 'KeyB',
        ctrlKey: true,
        key: 'x',
      });

      expect(
        isExactShortcutMatch(eventWithoutUppercase, 'x', {ctrlKey: true}),
      ).toBe(true);
      expect(
        isExactShortcutMatch(eventWithoutUppercase, 'b', {ctrlKey: true}),
      ).toBe(false);

      const eventWithUppercase = new KeyboardEvent('keydown', {
        code: 'KeyB',
        ctrlKey: true,
        key: 'X',
      });

      expect(
        isExactShortcutMatch(eventWithUppercase, 'x', {ctrlKey: true}),
      ).toBe(true);
      expect(
        isExactShortcutMatch(eventWithUppercase, 'b', {ctrlKey: true}),
      ).toBe(false);
    });

    test('isExactShortcutMatch() fallback to event.code for single-letter in event.key via non-English layout', () => {
      const eventWithoutUppercase = new KeyboardEvent('keydown', {
        code: 'KeyZ',
        ctrlKey: true,
        key: 'я',
      });

      expect(
        isExactShortcutMatch(eventWithoutUppercase, 'z', {ctrlKey: true}),
      ).toBe(true);

      const eventWithUppercase = new KeyboardEvent('keydown', {
        code: 'KeyZ',
        ctrlKey: true,
        key: 'Я',
      });

      expect(
        isExactShortcutMatch(eventWithUppercase, 'z', {ctrlKey: true}),
      ).toBe(true);
    });

    test('isExactShortcutMatch() matches special keys', () => {
      const eventWithEnter = new KeyboardEvent('keydown', {
        ctrlKey: true,
        key: 'Enter',
      });

      expect(
        isExactShortcutMatch(eventWithEnter, 'Enter', {ctrlKey: true}),
      ).toBe(true);

      const eventWithTab = new KeyboardEvent('keydown', {
        ctrlKey: true,
        key: 'Tab',
      });

      expect(isExactShortcutMatch(eventWithTab, 'Tab', {ctrlKey: true})).toBe(
        true,
      );

      const eventWithDelete = new KeyboardEvent('keydown', {
        ctrlKey: true,
        key: 'Delete',
      });

      expect(
        isExactShortcutMatch(eventWithDelete, 'Delete', {ctrlKey: true}),
      ).toBe(true);
    });

    test('isExactShortcutMatch() matches optional keys', () => {
      const eventWithCtrl = new KeyboardEvent('keydown', {
        ctrlKey: true,
        key: 'a',
      });

      expect(isExactShortcutMatch(eventWithCtrl, 'a', {ctrlKey: true})).toBe(
        true,
      );

      const eventWithShift = new KeyboardEvent('keydown', {
        key: 'a',
        shiftKey: true,
      });

      expect(isExactShortcutMatch(eventWithShift, 'a', {shiftKey: true})).toBe(
        true,
      );

      const eventWithMeta = new KeyboardEvent('keydown', {
        key: 'a',
        metaKey: true,
      });

      expect(isExactShortcutMatch(eventWithMeta, 'a', {metaKey: true})).toBe(
        true,
      );

      const eventWithoutCtrl = new KeyboardEvent('keydown', {key: 'a'});

      expect(isExactShortcutMatch(eventWithoutCtrl, 'a', {ctrlKey: true})).toBe(
        false,
      );
    });

    test('isTokenOrSegmented()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const node = $createTextNode('foo');
        expect($isTokenOrSegmented(node)).toBe(false);

        const tokenNode = $createTextNode().setMode('token');
        expect($isTokenOrSegmented(tokenNode)).toBe(true);

        const segmentedNode = $createTextNode('foo').setMode('segmented');
        expect($isTokenOrSegmented(segmentedNode)).toBe(true);
      });
    });

    test('$getNodeByKey', async () => {
      const {editor} = testEnv;
      let paragraphNode: ParagraphNode;
      let textNode: TextNode;

      await editor.update(() => {
        const rootNode = $getRoot();
        paragraphNode = new ParagraphNode();
        textNode = new TextNode('foo');
        paragraphNode.append(textNode);
        rootNode.append(paragraphNode);
      });

      await editor.read('latest', () => {
        expect($getNodeByKey('1')).toBe(paragraphNode);
        expect($getNodeByKey('2')).toBe(textNode);
        expect($getNodeByKey('3')).toBe(null);
      });

      // @ts-expect-error
      expect(() => $getNodeByKey()).toThrow();
    });

    test('$nodesOfType', async () => {
      const {editor} = testEnv;
      const paragraphKeys: string[] = [];

      const $paragraphKeys = () =>
        $nodesOfType(ParagraphNode).map(node => node.getKey());

      await editor.update(() => {
        const root = $getRoot();
        const paragraph1 = $createParagraphNode();
        const paragraph2 = $createParagraphNode();
        $createParagraphNode();
        root.append(paragraph1, paragraph2);
        paragraphKeys.push(paragraph1.getKey(), paragraph2.getKey());
        const currentParagraphKeys = $paragraphKeys();
        expect(currentParagraphKeys).toHaveLength(paragraphKeys.length);
        expect(currentParagraphKeys).toEqual(
          expect.arrayContaining(paragraphKeys),
        );
      });
      editor.read('latest', () => {
        const currentParagraphKeys = $paragraphKeys();
        expect(currentParagraphKeys).toHaveLength(paragraphKeys.length);
        expect(currentParagraphKeys).toEqual(
          expect.arrayContaining(paragraphKeys),
        );
      });
    });

    describe('$onUpdate', () => {
      test('deferred even when there are no dirty nodes', () => {
        const {editor} = testEnv;
        const runs: string[] = [];

        editor.update(
          () => {
            $onUpdate(() => {
              runs.push('second');
            });
          },
          {
            onUpdate: () => {
              runs.push('first');
            },
          },
        );
        expect(runs).toEqual([]);
        editor.update(() => {
          $onUpdate(() => {
            runs.push('third');
          });
        });
        expect(runs).toEqual([]);

        // Flush pending updates
        editor.read(() => {});

        expect(runs).toEqual(['first', 'second', 'third']);
      });

      test('added fn runs after update, original onUpdate, and prior calls to $onUpdate', () => {
        const {editor} = testEnv;
        const runs: string[] = [];

        editor.update(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('foo')),
            );
            $onUpdate(() => {
              runs.push('second');
            });
            $onUpdate(() => {
              runs.push('third');
            });
          },
          {
            onUpdate: () => {
              runs.push('first');
            },
          },
        );

        // Flush pending updates
        editor.read(() => {});

        expect(runs).toEqual(['first', 'second', 'third']);
      });

      test('adding fn throws outside update', () => {
        expect(() => {
          $onUpdate(() => {});
        }).toThrow();
      });
    });

    test('getCachedTypeToNodeMap', async () => {
      const {editor} = testEnv;
      const paragraphKeys: string[] = [];

      const initialTypeToNodeMap = getCachedTypeToNodeMap(
        editor.getEditorState(),
      );
      expect(getCachedTypeToNodeMap(editor.getEditorState())).toBe(
        initialTypeToNodeMap,
      );
      expect([...initialTypeToNodeMap.keys()]).toEqual(['root']);
      expect(initialTypeToNodeMap.get('root')).toMatchObject({size: 1});

      editor.update(
        () => {
          const root = $getRoot();
          const paragraph1 = $createParagraphNode().append(
            $createTextNode('a'),
          );
          const paragraph2 = $createParagraphNode().append(
            $createTextNode('b'),
          );
          // these will be garbage collected and not in the readonly map
          $createParagraphNode().append($createTextNode('c'));
          root.append(paragraph1, paragraph2);
          paragraphKeys.push(paragraph1.getKey(), paragraph2.getKey());
        },
        {discrete: true},
      );

      const typeToNodeMap = getCachedTypeToNodeMap(editor.getEditorState());
      // verify that the initial cache was not used
      expect(typeToNodeMap).not.toBe(initialTypeToNodeMap);
      // verify that the cache is used for subsequent calls
      expect(getCachedTypeToNodeMap(editor.getEditorState())).toBe(
        typeToNodeMap,
      );
      expect(typeToNodeMap.size).toEqual(3);
      expect([...typeToNodeMap.keys()]).toEqual(
        expect.arrayContaining(['root', 'paragraph', 'text']),
      );
      const paragraphMap = typeToNodeMap.get('paragraph')!;
      expect(paragraphMap.size).toEqual(paragraphKeys.length);
      expect([...paragraphMap.keys()]).toEqual(
        expect.arrayContaining(paragraphKeys),
      );
      const textMap = typeToNodeMap.get('text')!;
      expect(textMap.size).toEqual(2);
      expect(
        [...textMap.values()].map(
          node => $assertNodeType(node, $isTextNode).__text,
        ),
      ).toEqual(expect.arrayContaining(['a', 'b']));
    });

    test('scrollIntoViewIfNeeded respects scroll-padding on document element', () => {
      const {editor} = testEnv;
      const rootElement = editor.getRootElement()!;
      const doc = rootElement.ownerDocument;

      // Mock scrollBy to capture scroll amounts
      let scrollAmountWithPadding = 0;
      let scrollAmountWithoutPadding = 0;
      const scrollBySpy = vi.spyOn(window, 'scrollBy');

      // Create a selection rect near the top of the viewport
      const selectionRect = new DOMRect(100, 30, 10, 20);

      try {
        // Test WITHOUT scroll-padding
        doc.documentElement.style.scrollPaddingTop = '0px';
        scrollBySpy.mockImplementation((x: number, y: number) => {
          scrollAmountWithoutPadding = y;
        });
        scrollIntoViewIfNeeded(editor, selectionRect, rootElement);

        // Test WITH scroll-padding
        doc.documentElement.style.scrollPaddingTop = '60px';
        scrollBySpy.mockImplementation((x: number, y: number) => {
          scrollAmountWithPadding = y;
        });
        scrollIntoViewIfNeeded(editor, selectionRect, rootElement);

        // With scroll-padding-top of 60px, the effective targetTop is 60
        // So when selection is at top=30, it should scroll more (or differently)
        // than without scroll-padding where targetTop is 0
        // The difference should be the scroll-padding amount
        expect(scrollAmountWithPadding - scrollAmountWithoutPadding).toBe(-60);
      } finally {
        scrollBySpy.mockRestore();
        doc.documentElement.style.scrollPaddingTop = '';
      }
    });

    test('scrollIntoViewIfNeeded ignores a selection rect that lies entirely above the editor', () => {
      const {editor} = testEnv;
      const rootElement = editor.getRootElement()!;

      // Safari returns a degenerate/out-of-bounds rect for a collapsed caret in
      // RTL text (and reports it as type "Range", which routes execution into
      // this scroll path). The caret is reported above the editor's own box;
      // scrolling to it jumps the viewport up on every keystroke. See #2495.
      const scrollBySpy = vi
        .spyOn(window, 'scrollBy')
        .mockImplementation(() => {});
      const rootRectSpy = vi
        .spyOn(rootElement, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(0, 200, 300, 400));

      try {
        const bogusRect = new DOMRect(0, -40, 0, 18); // top -40, bottom -22
        scrollIntoViewIfNeeded(editor, bogusRect, rootElement);
        expect(scrollBySpy).not.toHaveBeenCalled();
      } finally {
        scrollBySpy.mockRestore();
        rootRectSpy.mockRestore();
      }
    });

    describe('scrollIntoViewIfNeeded in horizontal scroll containers', () => {
      // The code element's scrollport starts at x 10 and is 300px wide, and
      // it can scroll by up to 4700px. Carets are collapsed rects in viewport
      // coordinates. A line's text starts at content x 52, after the gutter,
      // so at scrollLeft s the start of a line is at 10 + 52 - s.
      interface ScrollerMetrics {
        clientLeft?: number;
        clientWidth: number;
        rect: DOMRect;
        scrollLeft?: number;
        scrollWidth: number;
      }

      function mockScroller(
        element: HTMLElement,
        {
          clientLeft = 0,
          clientWidth,
          rect,
          scrollLeft = 0,
          scrollWidth,
        }: ScrollerMetrics,
      ): void {
        vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect);
        for (const [name, value] of Object.entries({
          clientLeft,
          clientWidth,
          scrollWidth,
        })) {
          Object.defineProperty(element, name, {configurable: true, value});
        }
        // jsdom keeps whatever is assigned, without clamping it
        element.scrollLeft = scrollLeft;
      }

      interface SetUpOptions {
        codeRect?: DOMRect;
        codeStyle?: string;
        rootRect?: DOMRect;
        scrollLeft?: number;
      }

      // root > code > span > Text, in a root that Lexical does not own. The
      // editor argument is only used to find the window.
      function setUp({
        codeRect = new DOMRect(10, 0, 300, 100),
        codeStyle = '',
        rootRect = new DOMRect(0, 0, 800, 600),
        scrollLeft = 0,
      }: SetUpOptions = {}) {
        const root = document.createElement('div');
        const code = document.createElement('code');
        const span = document.createElement('span');
        span.textContent = 'caret';
        code.append(span);
        root.append(code);
        document.body.append(root);
        onTestFinished(() => root.remove());
        vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rootRect);
        code.setAttribute('style', `overflow-x: auto; ${codeStyle}`);
        mockScroller(code, {
          clientWidth: 300,
          rect: codeRect,
          scrollLeft,
          scrollWidth: 5000,
        });
        return {code, root, text: span.firstChild!};
      }

      function caretAt(x: number, top = 10): DOMRect {
        return new DOMRect(x, top, 0, 20);
      }

      /** Reveals a caret at x and returns the code element's scrollLeft. */
      function reveal(x: number, options?: SetUpOptions): number {
        const {code, root, text} = setUp(options);
        scrollIntoViewIfNeeded(testEnv.editor, caretAt(x), root, text);
        return code.scrollLeft;
      }

      beforeEach(() => {
        vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      test('scrolls to reveal a caret past the right edge', () => {
        // The caret is painted 1px wide, so its right edge 1011 lines up with
        // the scrollport's right edge at 310.
        expect(reveal(1010)).toBe(701);
        // Clamped to scrollWidth - clientWidth
        expect(reveal(10000)).toBe(4700);

        // A 15px left border moves the scrollport's right edge to 325
        const {code, root, text} = setUp();
        Object.defineProperty(code, 'clientLeft', {
          configurable: true,
          value: 15,
        });
        scrollIntoViewIfNeeded(testEnv.editor, caretAt(1010), root, text);
        expect(code.scrollLeft).toBe(686);
      });

      test('scrolls all the way back when the caret fits at scrollLeft 0', () => {
        const padding = 'scroll-padding-left: 52px';
        // A line start at scrollLeft 400, with and without scroll-padding.
        // Without it the minimal reveal would stop at 52.
        expect(reveal(-338, {codeStyle: padding, scrollLeft: 400})).toBe(0);
        expect(reveal(-338, {scrollLeft: 400})).toBe(0);
        // A gutter wider than its scroll-padding (text at content x 58)
        expect(reveal(-332, {codeStyle: padding, scrollLeft: 400})).toBe(0);
        // After 8 spaces of indentation (content x 115), where smart Home and
        // Enter leave the caret. The minimal reveals would stop at 63 and 115.
        expect(reveal(-3875, {codeStyle: padding, scrollLeft: 4000})).toBe(0);
        expect(reveal(-3875, {scrollLeft: 4000})).toBe(0);
      });

      test('keeps the caret out of the scroll-padding when it does not fit at scrollLeft 0', () => {
        // Mid line, content x 500
        expect(
          reveal(-490, {
            codeStyle: 'scroll-padding-left: 52px',
            scrollLeft: 1000,
          }),
        ).toBe(448);
        // A deep indent, content x 400: the caret lands at viewLeft 62
        expect(
          reveal(-3590, {
            codeStyle: 'scroll-padding-left: 52px',
            scrollLeft: 4000,
          }),
        ).toBe(348);
        // A percentage resolves against clientWidth: 10% of 300 is 30px
        expect(
          reveal(-490, {
            codeStyle: 'scroll-padding-left: 10%',
            scrollLeft: 1000,
          }),
        ).toBe(470);
      });

      test('scrolls right to left containers with negative scrollLeft', () => {
        // The inline start is on the right, so viewRight is 310 - 52 = 258
        const codeStyle = 'direction: rtl; scroll-padding-right: 52px';
        expect(reveal(658, {codeStyle, scrollLeft: -400})).toBe(0);
        // At scrollLeft 0 this caret is at 195, inside the view. The minimal
        // reveal would stop at -62.
        expect(reveal(4195, {codeStyle, scrollLeft: -4000})).toBe(0);
        // Away from the start there is no snap back
        expect(reveal(-1000, {codeStyle})).toBe(-1010);
        expect(reveal(-10000, {codeStyle})).toBe(-4700);
      });

      test('rounds the scroll position toward the caret', () => {
        // Browsers round scrollLeft. Here the caret is 0.14px left of the
        // view, and -1000.14 rounded to the nearest px would leave it there.
        expect(
          reveal(9.86, {codeStyle: 'direction: rtl', scrollLeft: -1000}),
        ).toBe(-1001);
        // The same moving back in a left to right line
        expect(reveal(9.86, {scrollLeft: 1000})).toBe(999);
        // The caret's right edge 310.4 is 0.4px past the view
        expect(reveal(309.4, {scrollLeft: 1000})).toBe(1001);
      });

      test('reveals the inline start of a rect wider than the view', () => {
        // An element point is measured on the whole node after it, here
        // 1000px wide. The caret is at its inline start.
        const ltr = setUp();
        scrollIntoViewIfNeeded(
          testEnv.editor,
          new DOMRect(400, 10, 1000, 20),
          ltr.root,
          ltr.text,
        );
        expect(ltr.code.scrollLeft).toBe(91);

        const rtl = setUp({codeStyle: 'direction: rtl'});
        scrollIntoViewIfNeeded(
          testEnv.editor,
          new DOMRect(-1000, 10, 1000, 20),
          rtl.root,
          rtl.text,
        );
        expect(rtl.code.scrollLeft).toBe(-11);
      });

      test('leaves a visible caret alone and skips styles when nothing overflows', () => {
        expect(reveal(100)).toBe(0);

        const {code, root, text} = setUp({scrollLeft: 0});
        Object.defineProperty(code, 'scrollWidth', {
          configurable: true,
          value: 300,
        });
        const getComputedStyleSpy = vi.spyOn(window, 'getComputedStyle');
        scrollIntoViewIfNeeded(testEnv.editor, caretAt(1010), root, text);
        expect(code.scrollLeft).toBe(0);
        expect(getComputedStyleSpy).not.toHaveBeenCalledWith(code);
      });

      test.each(['visible', 'hidden', 'clip'])(
        'ignores an element with overflow-x: %s',
        overflowX => {
          const {code, root, text} = setUp();
          code.style.overflowX = overflowX;
          scrollIntoViewIfNeeded(testEnv.editor, caretAt(1010), root, text);
          expect(code.scrollLeft).toBe(0);
        },
      );

      test('reveals a caret above or below a scroller sideways too', () => {
        // Like a code block with a max-height, scrolled so the caret's line
        // is out of view. Scrolling sideways doesn't move the caret up or
        // down, so its right edge 1011 still lines up with 310.
        expect(reveal(1010, {codeRect: new DOMRect(10, 200, 300, 100)})).toBe(
          701,
        );
        expect(reveal(1010, {codeRect: new DOMRect(10, -200, 300, 100)})).toBe(
          701,
        );
      });

      test('reveals a caret below and right of a root that scrolls both ways', () => {
        // A 300 by 100 root with overflow: auto, and a caret at (800, 500).
        // Only the root scrolls here. jsdom doesn't expand the overflow
        // shorthand, so the root gets both longhands.
        const {code, root, text} = setUp();
        code.style.overflowX = 'visible';
        root.style.overflowX = 'auto';
        root.style.overflowY = 'auto';
        mockScroller(root, {
          clientWidth: 300,
          rect: new DOMRect(0, 0, 300, 100),
          scrollWidth: 2000,
        });
        scrollIntoViewIfNeeded(
          testEnv.editor,
          new DOMRect(800, 500, 0, 19),
          root,
          text,
        );
        // The caret's bottom 519 is 419px below the root's bottom at 100
        expect(root.scrollTop).toBe(419);
        // and its right edge 801 is 501px past the root's right edge at 300
        expect(root.scrollLeft).toBe(501);
      });

      test('scrolls nested scroll containers from the caret outward', () => {
        const {code, root, text} = setUp();
        const wrapper = document.createElement('div');
        wrapper.style.overflowX = 'auto';
        root.append(wrapper);
        wrapper.append(code);
        mockScroller(wrapper, {
          clientWidth: 200,
          rect: new DOMRect(0, 0, 200, 200),
          scrollWidth: 400,
        });
        scrollIntoViewIfNeeded(testEnv.editor, caretAt(1010), root, text);
        expect(code.scrollLeft).toBe(701);
        // The caret is now at 309, and its right edge 310 is 110px past the
        // wrapper's right edge at 200.
        expect(wrapper.scrollLeft).toBe(110);
      });

      test('reveals the caret in a zoomed or scaled scroll container', () => {
        // Rects are in viewport px, while clientWidth, scroll-padding and
        // scrollLeft are in the element's own px. The rect's width is the
        // scale times offsetWidth.
        function setOffsetWidth(element: HTMLElement, value: number): void {
          Object.defineProperty(element, 'offsetWidth', {
            configurable: true,
            value,
          });
        }
        function setUpScaled(scale: number, options?: SetUpOptions) {
          const elements = setUp({
            codeRect: new DOMRect(10, 0, 300 * scale, 100 * scale),
            ...options,
          });
          setOffsetWidth(elements.code, 300);
          return elements;
        }
        function revealScaled(
          x: number,
          scale: number,
          options?: SetUpOptions,
        ): number {
          const {code, root, text} = setUpScaled(scale, options);
          scrollIntoViewIfNeeded(testEnv.editor, caretAt(x), root, text);
          return code.scrollLeft;
        }

        // At scale 2 the scrollport's right edge is at 610. The caret's right
        // edge 1011 is 401px past it, which is 200.5px of the element's own,
        // rounded up to 201.
        expect(revealScaled(1010, 2)).toBe(201);
        // At scale 0.5 the right edge is at 160, and 851px is 1702px
        expect(revealScaled(1010, 0.5)).toBe(1702);
        // 52px of scroll-padding is 104px on screen. Mid line, content x 500:
        const codeStyle = 'scroll-padding-left: 52px';
        expect(revealScaled(-990, 2, {codeStyle, scrollLeft: 1000})).toBe(448);
        // After 8 spaces, content x 115, the caret is at 240 at scrollLeft 0
        expect(revealScaled(-560, 2, {codeStyle, scrollLeft: 400})).toBe(0);
        // Right to left, viewRight is 10 + (300 - 52) * 2 = 506. The caret's
        // right edge 6001 is 5495px past it, which is 2747.5px, so -1252.5
        // rounds toward the caret to -1252.
        expect(
          revealScaled(6000, 2, {
            codeStyle: 'direction: rtl; scroll-padding-right: 52px',
            scrollLeft: -4000,
          }),
        ).toBe(-1252);

        // A 15px left border is 30px on screen
        const bordered = setUpScaled(2);
        Object.defineProperty(bordered.code, 'clientLeft', {
          configurable: true,
          value: 15,
        });
        scrollIntoViewIfNeeded(
          testEnv.editor,
          caretAt(1010),
          bordered.root,
          bordered.text,
        );
        expect(bordered.code.scrollLeft).toBe(186);

        // An outer scroller gets what the inner one scrolled on screen. The
        // caret's right edge ends up at 609, 209px past the wrapper's right
        // edge at 400, which is 104.5px of the wrapper's own.
        const {code, root, text} = setUpScaled(2);
        const wrapper = document.createElement('div');
        wrapper.style.overflowX = 'auto';
        root.append(wrapper);
        wrapper.append(code);
        mockScroller(wrapper, {
          clientWidth: 200,
          rect: new DOMRect(0, 0, 400, 400),
          scrollWidth: 400,
        });
        setOffsetWidth(wrapper, 200);
        scrollIntoViewIfNeeded(testEnv.editor, caretAt(1010), root, text);
        expect(code.scrollLeft).toBe(201);
        expect(wrapper.scrollLeft).toBe(105);

        // offsetWidth is rounded, so a difference of 1px or less is not a
        // scale
        const rounded = setUp({codeRect: new DOMRect(10, 0, 300.6, 100)});
        setOffsetWidth(rounded.code, 301);
        scrollIntoViewIfNeeded(
          testEnv.editor,
          caretAt(1010),
          rounded.root,
          rounded.text,
        );
        expect(rounded.code.scrollLeft).toBe(701);
      });

      test('does not scroll the ancestors of the root sideways', () => {
        const {code, root, text} = setUp();
        const outer = document.createElement('div');
        outer.style.overflowX = 'auto';
        document.body.append(outer);
        outer.append(root);
        onTestFinished(() => outer.remove());
        mockScroller(outer, {
          clientWidth: 200,
          rect: new DOMRect(0, 0, 200, 700),
          scrollWidth: 2000,
        });
        scrollIntoViewIfNeeded(testEnv.editor, caretAt(1010), root, text);
        expect(code.scrollLeft).toBe(701);
        expect(outer.scrollLeft).toBe(0);
      });

      test('scrolls the editor root itself sideways', () => {
        // Only the root scrolls here, as in a plain text editor that doesn't
        // wrap its lines.
        const {code, root, text} = setUp();
        code.style.overflowX = 'visible';
        root.style.overflowX = 'auto';
        mockScroller(root, {
          clientWidth: 800,
          rect: new DOMRect(0, 0, 800, 600),
          scrollWidth: 2000,
        });
        scrollIntoViewIfNeeded(testEnv.editor, caretAt(1010), root, text);
        expect(code.scrollLeft).toBe(0);
        // The caret's right edge 1011 is 211px past the root's right edge
        expect(root.scrollLeft).toBe(211);
      });

      test('ignores a rect above the editor and an empty rect', () => {
        const above = setUp({rootRect: new DOMRect(0, 200, 300, 400)});
        scrollIntoViewIfNeeded(
          testEnv.editor,
          caretAt(1010, -40),
          above.root,
          above.text,
        );
        expect(above.code.scrollLeft).toBe(0);

        const empty = setUp({scrollLeft: 400});
        scrollIntoViewIfNeeded(
          testEnv.editor,
          new DOMRect(),
          empty.root,
          empty.text,
        );
        expect(empty.code.scrollLeft).toBe(400);
      });

      test('still scrolls the window vertically, and only vertically', () => {
        const {code, root, text} = setUp({
          codeRect: new DOMRect(10, 880, 300, 100),
          rootRect: new DOMRect(0, 0, 800, 2000),
        });
        scrollIntoViewIfNeeded(testEnv.editor, caretAt(1010, 900), root, text);
        expect(code.scrollLeft).toBe(701);
        expect(window.scrollBy).toHaveBeenCalledTimes(1);
        expect(window.scrollBy).toHaveBeenCalledWith(
          0,
          920 - window.innerHeight,
        );
      });

      test('only scrolls vertically without a selection node', () => {
        const {code, root} = setUp();
        scrollIntoViewIfNeeded(testEnv.editor, caretAt(1010), root);
        expect(code.scrollLeft).toBe(0);
      });
    });

    describe('getCaretRect, which measures the caret for scrollIntoViewIfNeeded', () => {
      const CARET = new DOMRect(40, 10, 0, 15);
      const CHARACTER = new DOMRect(32, 10, 8, 15);

      function textNode(text: string): Text {
        const span = document.createElement('span');
        const node = document.createTextNode(text);
        span.append(node);
        document.body.append(span);
        onTestFinished(() => span.remove());
        return node;
      }

      function caretIn(node: Node, offset: number): Range {
        const range = document.createRange();
        range.setStart(node, offset);
        return range;
      }

      // Collapsed ranges get `caret`, like WebKit, which gives a caret at
      // the logical end of right to left text no rect at all. Other ranges
      // get CHARACTER. Returns the ranges that were measured.
      function mockRangeRects(caret: DOMRect): Range[] {
        const measured: Range[] = [];
        const spy = vi
          .spyOn(Range.prototype, 'getBoundingClientRect')
          .mockImplementation(function (this: Range) {
            measured.push(this.cloneRange());
            return this.collapsed ? caret : CHARACTER;
          });
        onTestFinished(() => spy.mockRestore());
        return measured;
      }

      test('returns the rect of a caret that has one', () => {
        const measured = mockRangeRects(CARET);
        const text = textNode('שלום');
        expect(getCaretRect(caretIn(text, 4))).toBe(CARET);
        expect(measured).toHaveLength(1);
      });

      test('measures the character before a caret that has no rect', () => {
        const measured = mockRangeRects(new DOMRect());
        const text = textNode('שלום');
        expect(getCaretRect(caretIn(text, 4))).toBe(CHARACTER);
        expect(measured).toHaveLength(2);
        expect(measured[1].startContainer).toBe(text);
        expect(measured[1].startOffset).toBe(3);
        expect(measured[1].endOffset).toBe(4);
      });

      test('measures the first character for a caret at the start that has no rect', () => {
        const measured = mockRangeRects(new DOMRect());
        const text = textNode('שלום');
        expect(getCaretRect(caretIn(text, 0))).toBe(CHARACTER);
        expect(measured).toHaveLength(2);
        expect(measured[1].startOffset).toBe(0);
        expect(measured[1].endOffset).toBe(1);
      });

      test('keeps the empty rect when there is no character to measure', () => {
        const empty = new DOMRect();
        const measured = mockRangeRects(empty);
        expect(getCaretRect(caretIn(textNode(''), 0))).toBe(empty);
        const span = textNode('text').parentNode!;
        expect(getCaretRect(caretIn(span, 0))).toBe(empty);
        expect(measured).toHaveLength(2);
      });
    });
  });
});
describe('$applyNodeReplacement', () => {
  class ExtendedTextNode extends TextNode {
    static getType() {
      return 'extended-text';
    }
    static clone(node: ExtendedTextNode): ExtendedTextNode {
      return new ExtendedTextNode(node.__text, node.getKey());
    }
    initWithTextNode(node: TextNode): this {
      const self = this.getWritable();
      TextNode.prototype.updateFromJSON.call(self, node.exportJSON());
      return self;
    }
    static importJSON(serializedNode: SerializedTextNode): ExtendedTextNode {
      return $createExtendedTextNode().updateFromJSON(serializedNode);
    }
  }
  class ExtendedExtendedTextNode extends ExtendedTextNode {
    static getType() {
      return 'extended-extended-text';
    }
    static clone(node: ExtendedExtendedTextNode): ExtendedExtendedTextNode {
      return new ExtendedExtendedTextNode(node.__text, node.getKey());
    }
    initWithExtendedTextNode(node: ExtendedTextNode): this {
      return this.initWithTextNode(node);
    }
    static importJSON(
      serializedNode: SerializedTextNode,
    ): ExtendedExtendedTextNode {
      return $createExtendedExtendedTextNode().updateFromJSON(serializedNode);
    }
  }
  function $createExtendedTextNode(text: string = '') {
    return $applyNodeReplacement(new ExtendedTextNode(text));
  }
  function $createExtendedExtendedTextNode(text: string = '') {
    return $applyNodeReplacement(new ExtendedExtendedTextNode(text));
  }
  test('validates replace node configuration', () => {
    const editor = createEditor({
      nodes: [
        {
          replace: TextNode,
          with: node => $createExtendedTextNode().initWithTextNode(node),
          withKlass: ExtendedExtendedTextNode,
        },
      ],
      onError(err) {
        throw err;
      },
    });
    expect(() => {
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append($createParagraphNode().append($createTextNode('text')));
        },
        {discrete: true},
      );
    }).toThrow(
      'Attempted to create node ExtendedTextNode that was not configured to be used on the editor',
    );
  });
  test('validates replace node type withKlass', () => {
    const editor = createEditor({
      nodes: [
        {
          replace: TextNode,
          with: node => node,
          withKlass: ExtendedTextNode,
        },
      ],
      onError(err) {
        throw err;
      },
    });
    expect(() => {
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append($createParagraphNode().append($createTextNode('text')));
        },
        {discrete: true},
      );
    }).toThrow(
      '$applyNodeReplacement failed. Expected replacement node to be an instance of ExtendedTextNode with type extended-text but returned TextNode with type text from original node TextNode with type text',
    );
  });
  test('validates replace node type change', () => {
    const mockWarning = vi
      .spyOn(console, 'warn')
      .mockImplementationOnce(() => {});
    const editor = createEditor({
      nodes: [
        {
          replace: TextNode,
          with: (node: TextNode) => new TextNode(node.__text),
        },
      ],
      onError(err) {
        throw err;
      },
    });
    expect(mockWarning).toHaveBeenCalledWith(
      `Override for TextNode specifies 'replace' without 'withKlass'. 'withKlass' will be required in a future version.`,
    );
    mockWarning.mockRestore();
    expect(() => {
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append($createParagraphNode().append($createTextNode('text')));
        },
        {discrete: true},
      );
    }).toThrow(
      '$applyNodeReplacement failed. Ensure replacement node TextNode with type text is a subclass of the original node TextNode with type text',
    );
  });
  test('validates replace node key change', () => {
    const editor = createEditor({
      nodes: [
        {
          replace: TextNode,
          with: (node: TextNode) =>
            new ExtendedTextNode(node.__text, node.getKey()),
          withKlass: ExtendedTextNode,
        },
      ],
      onError(err) {
        throw err;
      },
    });
    expect(() => {
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append($createParagraphNode().append($createTextNode('text')));
        },
        {discrete: true},
      );
    }).toThrow(
      'Lexical node with constructor ExtendedTextNode attempted to re-use key from node in active editor state with constructor TextNode. Keys must not be re-used when the type is changed.',
    );
  });
  test('validates replace node configuration withKlass', () => {
    const editor = createEditor({
      nodes: [
        {
          replace: TextNode,
          with: node => $createExtendedTextNode().initWithTextNode(node),
          withKlass: ExtendedTextNode,
        },
      ],
      onError(err) {
        throw err;
      },
    });
    expect(() => {
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append($createParagraphNode().append($createTextNode('text')));
        },
        {discrete: true},
      );
    }).toThrow(
      'Attempted to create node ExtendedTextNode that was not configured to be used on the editor',
    );
  });
  test('validates nested replace node configuration', () => {
    const editor = createEditor({
      nodes: [
        ExtendedTextNode,
        {
          replace: ExtendedTextNode,
          with: node =>
            $createExtendedExtendedTextNode().initWithExtendedTextNode(node),
          withKlass: ExtendedExtendedTextNode,
        },
      ],
      onError(err) {
        throw err;
      },
    });
    expect(() => {
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append($createExtendedTextNode('text')),
            );
        },
        {discrete: true},
      );
    }).toThrow(
      'Attempted to create node ExtendedExtendedTextNode that was not configured to be used on the editor',
    );
  });
  test('validates nested replace node configuration withKlass', () => {
    const editor = createEditor({
      nodes: [
        ExtendedTextNode,
        {
          replace: TextNode,
          with: node => $createExtendedTextNode().initWithTextNode(node),
          withKlass: ExtendedTextNode,
        },
        {
          replace: ExtendedTextNode,
          with: node =>
            $createExtendedExtendedTextNode().initWithExtendedTextNode(node),
          withKlass: ExtendedExtendedTextNode,
        },
      ],
      onError(err) {
        throw err;
      },
    });
    expect(() => {
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append($createParagraphNode().append($createTextNode('text')));
        },
        {discrete: true},
      );
    }).toThrow(
      'Attempted to create node ExtendedExtendedTextNode that was not configured to be used on the editor',
    );
  });
  test('nested replace node configuration works', () => {
    const editor = createEditor({
      nodes: [
        ExtendedTextNode,
        ExtendedExtendedTextNode,
        {
          replace: TextNode,
          with: node => $createExtendedTextNode().initWithTextNode(node),
          withKlass: ExtendedTextNode,
        },
        {
          replace: ExtendedTextNode,
          with: node =>
            $createExtendedExtendedTextNode().initWithExtendedTextNode(node),
          withKlass: ExtendedExtendedTextNode,
        },
      ],
      onError(err) {
        throw err;
      },
    });
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('text')));
      },
      {discrete: true},
    );
    editor.read(() => {
      const textNodes = $getRoot().getAllTextNodes();
      expect(textNodes).toHaveLength(1);
      expect(textNodes[0].constructor).toBe(ExtendedExtendedTextNode);
      expect(textNodes[0].getTextContent()).toBe('text');
    });
  });
});
describe('$copyNode', () => {
  const STRING_STATE = createState('string-state', {
    parse: v => (typeof v === 'string' ? v : ''),
  });
  class ExtendedParagraphNode extends ParagraphNode {
    __string: string = 'default';
    $config() {
      return this.config('extended-paragraph', {extends: ParagraphNode});
    }
    afterCloneFrom(prevNode: this): void {
      super.afterCloneFrom(prevNode);
      this.__string = prevNode.__string;
    }
    setString(value: string): this {
      const writable = this.getWritable();
      writable.__string = value;
      return writable;
    }
  }
  function $createExtendedParagraphNode() {
    return $applyNodeReplacement(new ExtendedParagraphNode());
  }
  function $isExtendedParagraphNode(node: unknown) {
    return node instanceof ExtendedParagraphNode;
  }
  test('does not mark the original as dirty', () => {
    const editor = createEditor({
      nodes: [ExtendedParagraphNode, TextNode, ParagraphNode],
      onError(err) {
        throw err;
      },
    });
    let initialParagraph: ExtendedParagraphNode;
    editor.update(
      () => {
        initialParagraph = $createExtendedParagraphNode();
        $getRoot()
          .clear()
          .append(initialParagraph.append($createTextNode('text')));
      },
      {discrete: true},
    );
    editor.update(
      () => {
        expect($getRoot().getFirstChild()).toBe(initialParagraph);
        const copiedParagraph = $copyNode(initialParagraph);
        expect($getRoot().getFirstChild()).toBe(initialParagraph);
        expect(copiedParagraph).not.toBe(initialParagraph);
        expect($isExtendedParagraphNode(copiedParagraph)).toBe(true);
      },
      {discrete: true},
    );
  });
  test('returns a shallow copy', () => {
    const editor = createEditor({
      nodes: [ExtendedParagraphNode, TextNode, ParagraphNode],
      onError(err) {
        throw err;
      },
    });
    let initialParagraph: ExtendedParagraphNode;
    let copiedParagraph: ExtendedParagraphNode;
    editor.update(
      () => {
        initialParagraph =
          $createExtendedParagraphNode().setString('non-default');
        $setState(initialParagraph, STRING_STATE, 'non-default');
        const root = $getRoot().clear();
        root.append(initialParagraph.append($createTextNode('text')));
        copiedParagraph = $copyNode(initialParagraph);
        root.append(copiedParagraph);
        $setState(
          initialParagraph.setString('not-aliased'),
          STRING_STATE,
          'not-aliased',
        );
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($getRoot().getChildren()).toEqual([
        initialParagraph,
        copiedParagraph,
      ]);
      expect(initialParagraph.getTextContent()).toBe('text');
      expect(copiedParagraph.getTextContent()).toBe('');
      expect($getState(initialParagraph, STRING_STATE)).toBe('not-aliased');
      expect($getState(copiedParagraph, STRING_STATE)).toBe('non-default');
      expect(initialParagraph.__string).toBe('not-aliased');
      expect(copiedParagraph.__string).toBe('non-default');
    });
  });
});

describe('getRegisteredSubtypeMap', () => {
  const toObject = (map: Map<string, Set<string>>) =>
    Object.fromEntries(
      [...map].map(([type, subtypes]) => [type, [...subtypes].sort()]),
    );

  test('maps each type to itself and its registered subclass types', () => {
    expect(
      toObject(
        getRegisteredSubtypeMap([
          TextNode,
          TabNode,
          ParagraphNode,
          LineBreakNode,
        ]),
      ),
    ).toEqual({
      linebreak: ['linebreak'],
      paragraph: ['paragraph'],
      tab: ['tab'],
      text: ['tab', 'text'],
    });
  });

  test('expands a $config subclass under its base type', () => {
    class TextNodeA extends TextNode {
      $config() {
        return this.config('text-a', {extends: TextNode});
      }
    }
    expect(toObject(getRegisteredSubtypeMap([TextNode, TextNodeA]))).toEqual({
      text: ['text', 'text-a'],
      'text-a': ['text-a'],
    });
  });

  test('omits an unregistered base type even when a subclass is registered', () => {
    class TextNodeA extends TextNode {
      $config() {
        return this.config('text-a', {extends: TextNode});
      }
    }
    const map = getRegisteredSubtypeMap([TextNodeA]);
    expect(map.has('text')).toBe(false);
    expect([...map.get('text-a')!].sort()).toEqual(['text-a']);
  });
});

describe('$updateTextNodeFromDOMContent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createEditorWithTextNode(initialText: string) {
    const editor = createEditor({
      namespace: 'test',
      nodes: [ParagraphNode, TextNode],
      onError(error) {
        throw error;
      },
    });

    let textNode!: TextNode;
    editor.update(
      () => {
        textNode = $createTextNode(initialText).toggleUnmergeable();
        $getRoot().append($createParagraphNode().append(textNode));
      },
      {discrete: true},
    );

    return {editor, textNode};
  }

  test('removes delayed composition text node if it stays empty', () => {
    const {editor, textNode} = createEditorWithTextNode('ツ');

    editor.update(
      () => {
        $setCompositionKey(textNode.getKey());
      },
      {discrete: true},
    );

    editor.update(
      () => {
        $updateTextNodeFromDOMContent(textNode.getLatest(), '', 0, 0, false);
      },
      {discrete: true},
    );

    editor.read(() => {
      expect(textNode.getLatest().getTextContent()).toBe('');
    });

    vi.runOnlyPendingTimers();

    editor.read(() => {
      expect(() => textNode.getLatest()).toThrow();
    });
  });

  test('does not remove delayed composition text node if IME repopulates it', () => {
    const {editor, textNode} = createEditorWithTextNode('ツ');

    editor.update(
      () => {
        $setCompositionKey(textNode.getKey());
      },
      {discrete: true},
    );

    editor.update(
      () => {
        $updateTextNodeFromDOMContent(textNode.getLatest(), '', 0, 0, false);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        $updateTextNodeFromDOMContent(textNode.getLatest(), 'ツ', 1, 1, false);
      },
      {discrete: true},
    );

    vi.runOnlyPendingTimers();

    editor.read(() => {
      expect(textNode.getLatest().getTextContent()).toBe('ツ');
    });
  });
});

describe('getParentElement', () => {
  test('crosses ShadowRoot to host when parentElement is null', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    onTestFinished(() => host.remove());
    const shadow = host.attachShadow({mode: 'open'});
    const child = document.createElement('span');
    shadow.appendChild(child);

    expect(getParentElement(child)).toBe(host);
  });

  test('returns the light-DOM parentElement when present', () => {
    const parent = document.createElement('div');
    const child = document.createElement('span');
    parent.appendChild(child);
    document.body.appendChild(parent);
    onTestFinished(() => parent.remove());

    expect(getParentElement(child)).toBe(parent);
  });

  test('crosses one ShadowRoot per call for nested shadow trees', () => {
    const outerHost = document.createElement('div');
    document.body.appendChild(outerHost);
    onTestFinished(() => outerHost.remove());
    const outerShadow = outerHost.attachShadow({mode: 'open'});
    const innerHost = document.createElement('div');
    outerShadow.appendChild(innerHost);
    const innerShadow = innerHost.attachShadow({mode: 'open'});
    const grandchild = document.createElement('span');
    innerShadow.appendChild(grandchild);

    // First call crosses the inner shadow boundary up to its host.
    expect(getParentElement(grandchild)).toBe(innerHost);
    // A second call from the inner host crosses the outer shadow boundary.
    expect(getParentElement(innerHost)).toBe(outerHost);
  });

  test('returns null for a detached node with no parent', () => {
    const orphan = document.createElement('span');
    expect(getParentElement(orphan)).toBeNull();
  });

  test('returns parent element for a text node inside a shadow tree', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    onTestFinished(() => host.remove());
    const shadow = host.attachShadow({mode: 'open'});
    const span = document.createElement('span');
    shadow.appendChild(span);
    const text = document.createTextNode('hello');
    span.appendChild(text);

    // Text node's parentElement is the span (no boundary crossed yet).
    expect(getParentElement(text)).toBe(span);
    // From the span, the next call crosses the shadow boundary to the host.
    expect(getParentElement(span)).toBe(host);
  });
  describe('getStaticNodeConfig()', () => {
    test('derives the type and config from $config()', () => {
      class StaticConfigNode extends TextNode {
        $config() {
          return this.config('static-config-node', {extends: TextNode});
        }
      }

      const {ownNodeConfig, ownNodeType} =
        getStaticNodeConfig(StaticConfigNode);

      expect(ownNodeType).toBe('static-config-node');
      expect(ownNodeConfig).toMatchObject({
        extends: TextNode,
        type: 'static-config-node',
      });
      expect(StaticConfigNode.getType()).toBe('static-config-node');
    });

    test('caches the result for a node class', () => {
      const $config = vi.fn(function (this: TextNode) {
        return this.config('cached-static-config-node', {
          extends: TextNode,
        });
      });
      class CachedStaticConfigNode extends TextNode {
        $config() {
          return $config.call(this);
        }
      }

      const first = getStaticNodeConfig(CachedStaticConfigNode);
      const second = getStaticNodeConfig(CachedStaticConfigNode);

      expect(first).toBe(second);
      expect($config).toHaveBeenCalledTimes(1);
    });

    test('resolves symbol-keyed config for abstract node classes', () => {
      const {ownNodeConfig, ownNodeType} = getStaticNodeConfig(ElementNode);

      expect(ownNodeType).toBe(undefined);
      expect(ownNodeConfig).toMatchObject({
        // LexicalNode
        extends: ElementNode.prototype.constructor.prototype,
      });
      expect(ownNodeConfig?.$transform).toBeInstanceOf(Function);
    });
  });
  describe('iterStaticNodeConfigChain', () => {
    test('a subclass that declares no $config contributes nothing, and does not hide its parent', () => {
      // `getStaticNodeConfig` resolves such a class to its *ancestor's* config,
      // reached through the inherited method. Yielding that as the subclass's
      // own would both attribute the ancestor's declarations to it and present
      // them twice — and following the `extends` inside it would skip the
      // ancestor, which is where they are actually declared.
      class ChainBase extends ElementNode {
        $config() {
          return this.config('chain-base', {extends: ElementNode});
        }
      }
      class ChainSub extends ChainBase {}
      expect(
        Array.from(iterStaticNodeConfigChain(ChainSub)).map(config => [
          config.klass.name,
          config.ownNodeConfig === undefined,
        ]),
      ).toEqual([
        ['ChainSub', true],
        ['ChainBase', false],
        ['ElementNode', false],
        ['LexicalNode', true],
      ]);
    });

    test('an inline $transform is registered once for a subclass that declares no $config', () => {
      // A `$transform` written inline is a fresh closure on every `$config()`
      // call, so the Set that collects transforms cannot tell two copies of it
      // apart: yielding the ancestor's config for the subclass as well ran the
      // transform twice per node.
      const calls: string[] = [];
      class TransformBase extends ElementNode {
        $config() {
          return this.config('chain-transform-base', {
            $transform: (node: TransformBase) => {
              calls.push(node.getKey());
            },
            extends: ElementNode,
          });
        }
      }
      class TransformSub extends TransformBase {}
      const editor = createTestEditor({
        nodes: [TransformBase, TransformSub],
      });
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append(new TransformSub().append($createTextNode('x')));
        },
        {discrete: true},
      );
      expect(calls).toHaveLength(1);
    });

    test('handles a loose transform', () => {
      // These are from babel's loose class transform without the setPrototypeOf for the static chain
      // https://github.com/babel/babel/blob/main/packages/babel-helpers/src/helpers/inheritsLoose.ts
      function inheritsLoose(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
        subClass: Function,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
        superClass: Function,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ): any {
        subClass.prototype = Object.create(superClass.prototype);
        subClass.prototype.constructor = subClass;
        return subClass;
      }
      const LooseClassNode = inheritsLoose(
        function LooseClassNode_() {},
        Object.getPrototypeOf(ElementNode),
      );
      LooseClassNode.prototype.$config = function () {
        return this.config(Symbol.for('LooseClassNode'), {
          $transform: () => {},
        });
      };
      const LooseSubclassNode = inheritsLoose(
        function LooseSubclassNode_() {},
        LooseClassNode,
      );
      LooseSubclassNode.getType = () => 'loose';
      const looseChain = Array.from(
        iterStaticNodeConfigChain(LooseSubclassNode),
      );
      expect(looseChain.map(cfg => cfg.klass)).toEqual([
        LooseSubclassNode,
        LooseClassNode,
        Object.getPrototypeOf(ElementNode),
      ]);
      expect(looseChain).toHaveLength(3);
      expect(Object.getPrototypeOf(LooseSubclassNode)).not.toBe(LooseClassNode);
      expect(looseChain[0].ownNodeType).toBe('loose');
      expect(looseChain[0].ownNodeConfig).toBe(undefined);
      expect(looseChain[1].ownNodeConfig).not.toBe(undefined);
    });
    test('handles a class transform', () => {
      const paragraphChain = Array.from(
        iterStaticNodeConfigChain(ParagraphNode),
      );
      expect(paragraphChain.map(cfg => cfg.klass)).toEqual([
        ParagraphNode,
        ElementNode,
        Object.getPrototypeOf(ElementNode),
      ]);
    });
  });
});

describe('$getDocument', () => {
  initializeUnitTest(testEnv => {
    test('returns ownerDocument when rootElement is mounted', () => {
      const doc = testEnv.editor.read(() => $getDocument());
      expect(doc).toBe(testEnv.editor.getRootElement()!.ownerDocument);
    });

    test('returns globalThis.document when rootElement is null', () => {
      testEnv.editor.setRootElement(null);
      const doc = testEnv.editor.read(() => $getDocument());
      expect(doc).toBe(document);
    });

    test('returns globalThis.document when called with no active editor', () => {
      // Regression test for headless createDOM/exportDOM: $getDocument() must
      // not throw when invoked outside editor.update()/read() (i.e. with no
      // ambient active editor), so that nodes migrated off the bare `document`
      // global can still be serialized headlessly.
      expect(() => $getDocument()).not.toThrow();
      expect($getDocument()).toBe(document);
    });
  });
});
