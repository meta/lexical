/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $insertDataTransferForPlainText,
  $insertDataTransferForRichText,
} from '@lexical/clipboard';
import {$createListItemNode, $createListNode} from '@lexical/list';
import {registerTabIndentation} from '@lexical/react/LexicalTabIndentationPlugin';
import {$createHeadingNode, registerRichText} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTabNode,
  $createTextNode,
  $getCaretRange,
  $getCaretRangeInDirection,
  $getRoot,
  $getSelection,
  $getTextPointCaret,
  $insertNodes,
  $isElementNode,
  $isRangeSelection,
  $isTabNode,
  $isTextNode,
  $selectAll,
  $setSelection,
  $setSelectionFromCaretRange,
  KEY_TAB_COMMAND,
} from 'lexical';
import {beforeEach, describe, expect, test} from 'vitest';

import {initializeUnitTest, invariant} from '../../../__tests__/utils';

describe('LexicalTabNode tests', () => {
  initializeUnitTest(testEnv => {
    beforeEach(async () => {
      const {editor} = testEnv;
      await editor.update(() => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        root.append(paragraph);
        paragraph.select();
      });
    });

    test('can paste plain text with tabs and newlines in plain text', async () => {
      const {editor} = testEnv;
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', 'hello\tworld\nhello\tworld');
      await editor.update(() => {
        const selection = $getSelection();
        invariant($isRangeSelection(selection), 'isRangeSelection(selection)');
        $insertDataTransferForPlainText(dataTransfer, selection);
      });
      expect(testEnv.innerHTML).toBe(
        '<p dir="auto"><span data-lexical-text="true">hello</span><span data-lexical-text="true">\t</span><span data-lexical-text="true">world</span><br><span data-lexical-text="true">hello</span><span data-lexical-text="true">\t</span><span data-lexical-text="true">world</span></p>',
      );
    });

    test('can paste plain text with tabs and newlines in rich text', async () => {
      const {editor} = testEnv;
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', 'hello\tworld\nhello\tworld');
      await editor.update(() => {
        const selection = $getSelection();
        invariant($isRangeSelection(selection), 'isRangeSelection(selection)');
        $insertDataTransferForRichText(dataTransfer, selection, editor);
      });
      expect(testEnv.innerHTML).toBe(
        '<p dir="auto"><span data-lexical-text="true">hello</span><span data-lexical-text="true">\t</span><span data-lexical-text="true">world</span></p><p dir="auto"><span data-lexical-text="true">hello</span><span data-lexical-text="true">\t</span><span data-lexical-text="true">world</span></p>',
      );
    });

    // TODO fixme
    // test('can paste HTML with tabs and new lines #4429', async () => {
    //       const {editor} = testEnv;
    //       const dataTransfer = new DataTransfer();
    //       // https://codepen.io/zurfyx/pen/bGmrzMR
    //       dataTransfer.setData(
    //         'text/html',
    //         `<meta charset='utf-8'><span style="color: rgb(0, 0, 0); font-family: Times; font-size: medium; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; white-space: pre-wrap; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;">hello	world
    // hello	world</span>`,
    //       );
    //       await editor.update(() => {
    //         const selection = $getSelection();
    //         invariant($isRangeSelection(selection), 'isRangeSelection(selection)');
    //         $insertDataTransferForRichText(dataTransfer, selection, editor);
    //       });
    //       expect(testEnv.innerHTML).toBe(
    //         '<p dir="auto"><span data-lexical-text="true">hello</span><span data-lexical-text="true">\t</span><span data-lexical-text="true">world</span><br><span data-lexical-text="true">hello</span><span data-lexical-text="true">\t</span><span data-lexical-text="true">world</span></p>',
    //       );
    // });

    test('can paste HTML with tabs and new lines (2)', async () => {
      const {editor} = testEnv;
      const dataTransfer = new DataTransfer();
      // GDoc 2-liner hello\tworld (like previous test)
      dataTransfer.setData(
        'text/html',
        `<meta charset='utf-8'><meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-123"><p dir="ltr" style="line-height:1.38;margin-left: 36pt;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Hello</span><span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;"><span class="Apple-tab-span" style="white-space:pre;">	</span></span><span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">world</span></p><span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Hello</span><span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;"><span class="Apple-tab-span" style="white-space:pre;">	</span></span><span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">world</span></b>`,
      );
      await editor.update(() => {
        const selection = $getSelection();
        invariant($isRangeSelection(selection), 'isRangeSelection(selection)');
        $insertDataTransferForRichText(dataTransfer, selection, editor);
      });
      expect(testEnv.innerHTML).toBe(
        '<p dir="ltr"><span data-lexical-text="true">Hello</span><span data-lexical-text="true">\t</span><span data-lexical-text="true">world</span></p><p dir="auto"><span data-lexical-text="true">Hello</span><span data-lexical-text="true">\t</span><span data-lexical-text="true">world</span></p>',
      );
    });

    test('element indents when selection at the start of the block', async () => {
      const {editor} = testEnv;
      registerRichText(editor);
      registerTabIndentation(editor);
      await editor.update(() => {
        const selection = $getSelection()!;
        selection.insertText('foo');
        $getRoot().selectStart();
      });
      await editor.dispatchCommand(
        KEY_TAB_COMMAND,
        new KeyboardEvent('keydown'),
      );
      expect(testEnv.innerHTML).toBe(
        '<p dir="auto" style="padding-inline-start: calc(1 * var(--lexical-indent-base-value, 40px));"><span data-lexical-text="true">foo</span></p>',
      );
    });

    test('elements indent when selection spans across multiple blocks', async () => {
      const {editor} = testEnv;
      registerRichText(editor);
      registerTabIndentation(editor);
      await editor.update(() => {
        const root = $getRoot();
        const paragraph = root.getFirstChild();
        invariant($isElementNode(paragraph));
        const heading = $createHeadingNode('h1');
        const list = $createListNode('number');
        const listItem = $createListItemNode();
        const paragraphText = $createTextNode('foo');
        const headingText = $createTextNode('bar');
        const listItemText = $createTextNode('xyz');
        root.append(heading, list);
        paragraph.append(paragraphText);
        heading.append(headingText);
        list.append(listItem);
        listItem.append(listItemText);
        const selection = $createRangeSelection();
        selection.focus.set(paragraphText.getKey(), 1, 'text');
        selection.anchor.set(listItemText.getKey(), 1, 'text');
        $setSelection(selection);
      });
      await editor.dispatchCommand(
        KEY_TAB_COMMAND,
        new KeyboardEvent('keydown'),
      );
      expect(testEnv.innerHTML).toBe(
        '<p dir="auto" style="padding-inline-start: calc(1 * var(--lexical-indent-base-value, 40px));"><span data-lexical-text="true">foo</span></p>' +
          '<h1 dir="auto" style="padding-inline-start: calc(1 * var(--lexical-indent-base-value, 40px));"><span data-lexical-text="true">bar</span></h1>' +
          '<ol dir="auto"><li><ol><li><span data-lexical-text="true">xyz</span></li></ol></li></ol>',
      );
    });

    test('element tabs when selection is not at the start (1)', async () => {
      const {editor} = testEnv;
      registerRichText(editor);
      registerTabIndentation(editor);
      await editor.update(() => {
        $getSelection()!.insertText('foo');
      });
      await editor.dispatchCommand(
        KEY_TAB_COMMAND,
        new KeyboardEvent('keydown'),
      );
      expect(testEnv.innerHTML).toBe(
        '<p dir="auto"><span data-lexical-text="true">foo</span><span data-lexical-text="true">\t</span></p>',
      );
    });

    test('element tabs when selection is not at the start (2)', async () => {
      const {editor} = testEnv;
      registerRichText(editor);
      registerTabIndentation(editor);
      await editor.update(() => {
        $getSelection()!.insertText('foo');
        const textNode = $getRoot().getLastDescendant();
        invariant($isTextNode(textNode));
        textNode.select(1, 1);
      });
      await editor.dispatchCommand(
        KEY_TAB_COMMAND,
        new KeyboardEvent('keydown'),
      );
      expect(testEnv.innerHTML).toBe(
        '<p dir="auto"><span data-lexical-text="true">f</span><span data-lexical-text="true">\t</span><span data-lexical-text="true">oo</span></p>',
      );
    });

    test('element tabs when selection is not at the start (3)', async () => {
      const {editor} = testEnv;
      registerRichText(editor);
      registerTabIndentation(editor);
      await editor.update(() => {
        $getSelection()!.insertText('foo');
        const textNode = $getRoot().getLastDescendant();
        invariant($isTextNode(textNode));
        textNode.select(1, 2);
      });
      await editor.dispatchCommand(
        KEY_TAB_COMMAND,
        new KeyboardEvent('keydown'),
      );
      expect(testEnv.innerHTML).toBe(
        '<p dir="auto"><span data-lexical-text="true">f</span><span data-lexical-text="true">\t</span><span data-lexical-text="true">o</span></p>',
      );
    });

    test('elements tabs when selection is not at the start and overlaps another tab', async () => {
      const {editor} = testEnv;
      registerRichText(editor);
      registerTabIndentation(editor);
      await editor.update(() => {
        $getSelection()!.insertRawText('hello\tworld');
        const root = $getRoot();
        const firstTextNode = root.getFirstDescendant();
        const lastTextNode = root.getLastDescendant();
        const selection = $createRangeSelection();
        selection.anchor.set(firstTextNode!.getKey(), 'hell'.length, 'text');
        selection.focus.set(lastTextNode!.getKey(), 'wo'.length, 'text');
        $setSelection(selection);
      });
      await editor.dispatchCommand(
        KEY_TAB_COMMAND,
        new KeyboardEvent('keydown'),
      );
      expect(testEnv.innerHTML).toBe(
        '<p dir="auto"><span data-lexical-text="true">hell</span><span data-lexical-text="true">\t</span><span data-lexical-text="true">rld</span></p>',
      );
    });

    test('can type between two (leaf nodes) canInsertBeforeAfter false', async () => {
      const {editor} = testEnv;
      await editor.update(() => {
        const tab1 = $createTabNode();
        const tab2 = $createTabNode();
        $insertNodes([tab1, tab2]);
        tab1.select(1, 1);
        $getSelection()!.insertText('f');
      });
      expect(testEnv.innerHTML).toBe(
        '<p dir="auto"><span data-lexical-text="true">\t</span><span data-lexical-text="true">f</span><span data-lexical-text="true">\t</span></p>',
      );
    });

    test('can be serialized and deserialized', async () => {
      const {editor} = testEnv;
      await editor.update(() => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTabNode()));
        const textNodes = $getRoot().getAllTextNodes();
        expect(textNodes).toHaveLength(1);
        expect($isTabNode(textNodes[0])).toBe(true);
      });
      const json = editor.getEditorState().toJSON();
      await editor.update(() => {
        $getRoot().clear().append($createParagraphNode());
      });
      editor.read(() => {
        expect($getRoot().getAllTextNodes()).toHaveLength(0);
      });
      await editor.setEditorState(editor.parseEditorState(json));
      editor.read(() => {
        const textNodes = $getRoot().getAllTextNodes();
        expect(textNodes).toHaveLength(1);
        expect($isTabNode(textNodes[0])).toBe(true);
      });
    });

    describe('TabNode at selection boundaries with normal TextNode sibling (#7602)', () => {
      const input = 'x\tx';
      (['next', 'previous'] as const).forEach(direction => {
        [
          {output: 'yx', start: 0},
          {output: 'xy', start: 1},
        ].forEach(({output, start}) => {
          test(`TabNode ${JSON.stringify(input)} to ${JSON.stringify(
            output,
          )} at ${start} (${direction})`, () => {
            const {editor} = testEnv;
            editor.update(
              () => {
                $selectAll().insertRawText(input);
                const textNodes = $getRoot().getAllTextNodes();
                expect(textNodes.map($isTabNode)).toEqual([false, true, false]);
                const caretRange = $getCaretRange(
                  $getTextPointCaret(textNodes[start], 'next', 0),
                  $getTextPointCaret(textNodes[start + 1], 'next', 'next'),
                );
                const range = $setSelectionFromCaretRange(
                  $getCaretRangeInDirection(caretRange, direction),
                );
                range.insertRawText('y');
              },
              {discrete: true},
            );
            // Using read here because we want to see the post-normalization merged state
            editor.read(() => {
              const expectNodes = $getRoot().getAllTextNodes();
              expect(expectNodes.map(node => node.getTextContent())).toEqual([
                output,
              ]);
              expect(expectNodes.map($isTabNode)).toEqual([false]);
            });
          });
        });
      });
    });

    test('setTextContent normalizes back to \\t without throwing (#8596)', () => {
      // Safari's MutationObserver can deliver mid-IME-composition text writes
      // straight onto the TabNode's `\t` text node (verified with Korean), and
      // `flushMutations` then calls `TabNode.setTextContent` with the
      // in-flight composition payload (e.g. `'\tㅁ'`). The call must not throw
      // — a throw cascades through `onError` and freezes the editor.
      const {editor} = testEnv;
      editor.update(
        () => {
          const paragraph = $getRoot().getFirstChild();
          invariant($isElementNode(paragraph));
          const tabNode = $createTabNode();
          paragraph.append(tabNode);
          expect(() => tabNode.setTextContent('\tㅁ')).not.toThrow();
          expect(tabNode.getTextContent()).toBe('\t');
          expect(() => tabNode.setTextContent('arbitrary')).not.toThrow();
          expect(tabNode.getTextContent()).toBe('\t');
          expect(() => tabNode.setTextContent('')).not.toThrow();
          expect(tabNode.getTextContent()).toBe('\t');
        },
        {discrete: true},
      );
    });
  });
});
