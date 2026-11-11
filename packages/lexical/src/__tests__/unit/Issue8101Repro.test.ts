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
  $getHtmlContent,
  $insertGeneratedNodes,
} from '@lexical/clipboard';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $setSelection,
  type ElementFormatType,
} from 'lexical';
import {initializeUnitTest, invariant} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

/**
 * Builds `<p style="text-align: {format}">Hello</p><p>World</p>` and selects
 * the whole of the first paragraph's text, i.e. steps 1-3 of the report.
 */
function $setUpAndSelectFirstParagraph(format: ElementFormatType): void {
  const root = $getRoot();
  root.clear();
  const first = $createParagraphNode();
  first.setFormat(format);
  const text = $createTextNode('Hello');
  first.append(text);
  const second = $createParagraphNode();
  second.append($createTextNode('World'));
  root.append(first, second);
  const selection = $createRangeSelection();
  selection.anchor.set(text.getKey(), 0, 'text');
  selection.focus.set(text.getKey(), text.getTextContentSize(), 'text');
  $setSelection(selection);
}

describe('Text alignment is lost on copy-paste (#8101)', () => {
  initializeUnitTest(testEnv => {
    test('copying a whole aligned paragraph keeps the alignment in the Lexical clipboard payload', async () => {
      const {editor} = testEnv;
      await editor.update(() => $setUpAndSelectFirstParagraph('center'));

      editor.read(() => {
        const selection = $getSelection();
        invariant($isRangeSelection(selection), 'Expected RangeSelection');
        const {nodes} = $generateJSONFromSelectedNodes(editor, selection);
        // The copied payload must describe the paragraph, not just its text,
        // otherwise the alignment has nowhere to live.
        expect(nodes).toHaveLength(1);
        expect(nodes[0].type).toBe('paragraph');
        expect((nodes[0] as unknown as {format: string}).format).toBe('center');
      });
    });

    test('copying a whole aligned paragraph keeps the alignment in the HTML clipboard payload', async () => {
      const {editor} = testEnv;
      await editor.update(() => $setUpAndSelectFirstParagraph('right'));

      editor.read(() => {
        const selection = $getSelection();
        invariant($isRangeSelection(selection), 'Expected RangeSelection');
        expect($getHtmlContent(editor, selection)).toBe(
          '<p style="text-align: right;"><span style="white-space: pre-wrap;">Hello</span></p>',
        );
      });
    });

    test('a paragraph with no block-level state of its own still copies as inline content', async () => {
      const {editor} = testEnv;
      // '' is the default (unset) format, so this paragraph has no alignment,
      // indent or style to preserve. Wrapping it would change the clipboard
      // shape that every existing consumer already relies on.
      await editor.update(() => $setUpAndSelectFirstParagraph(''));

      editor.read(() => {
        const selection = $getSelection();
        invariant($isRangeSelection(selection), 'Expected RangeSelection');
        expect($getHtmlContent(editor, selection)).toBe(
          '<span style="white-space: pre-wrap;">Hello</span>',
        );
      });
    });

    test('copy a centered paragraph and paste it into an empty paragraph', async () => {
      const {editor} = testEnv;
      let payload = '';

      await editor.update(() => {
        const root = $getRoot();
        root.clear();
        const first = $createParagraphNode();
        first.setFormat('center');
        const text = $createTextNode('Hello');
        first.append(text);
        // The paste target: a second, default (left) aligned paragraph.
        root.append(first, $createParagraphNode());
        const selection = $createRangeSelection();
        selection.anchor.set(text.getKey(), 0, 'text');
        selection.focus.set(text.getKey(), text.getTextContentSize(), 'text');
        $setSelection(selection);
      });

      editor.read(() => {
        const selection = $getSelection();
        invariant($isRangeSelection(selection), 'Expected RangeSelection');
        payload = JSON.stringify(
          $generateJSONFromSelectedNodes(editor, selection),
        );
      });

      await editor.update(() => {
        const target = $getRoot().getLastChild();
        invariant($isElementNode(target), 'Expected an ElementNode');
        target.select();
      });

      await editor.update(() => {
        const selection = $getSelection();
        invariant($isRangeSelection(selection), 'Expected RangeSelection');
        $insertGeneratedNodes(
          editor,
          $generateNodesFromSerializedNodes(JSON.parse(payload).nodes),
          selection,
        );
      });

      editor.read(() => {
        const children = $getRoot().getChildren();
        expect(children).toHaveLength(2);
        const pasted = children[1];
        invariant($isElementNode(pasted), 'Expected an ElementNode');
        expect(pasted.getTextContent()).toBe('Hello');
        expect(pasted.getFormatType()).toBe('center');
      });
    });

    test('pasting a whole-line copy into the middle of another line still merges inline', async () => {
      const {editor} = testEnv;
      let payload = '';

      await editor.update(() => {
        const root = $getRoot();
        root.clear();
        const first = $createParagraphNode();
        const text = $createTextNode('Hello');
        first.append(text);
        const second = $createParagraphNode();
        second.append($createTextNode('abcdef'));
        root.append(first, second);
        const selection = $createRangeSelection();
        selection.anchor.set(text.getKey(), 0, 'text');
        selection.focus.set(text.getKey(), text.getTextContentSize(), 'text');
        $setSelection(selection);
      });

      editor.read(() => {
        const selection = $getSelection();
        invariant($isRangeSelection(selection), 'Expected RangeSelection');
        payload = JSON.stringify(
          $generateJSONFromSelectedNodes(editor, selection),
        );
      });

      await editor.update(() => {
        const second = $getRoot().getLastChild();
        invariant($isElementNode(second), 'Expected an ElementNode');
        const text = second.getFirstChild();
        invariant(text !== null, 'Expected a TextNode');
        const selection = $createRangeSelection();
        selection.anchor.set(text.getKey(), 3, 'text');
        selection.focus.set(text.getKey(), 3, 'text');
        $setSelection(selection);
      });

      await editor.update(() => {
        const selection = $getSelection();
        invariant($isRangeSelection(selection), 'Expected RangeSelection');
        $insertGeneratedNodes(
          editor,
          $generateNodesFromSerializedNodes(JSON.parse(payload).nodes),
          selection,
        );
      });

      editor.read(() => {
        const children = $getRoot().getChildren();
        // The copied block merges into the target line rather than splitting
        // it into a separate paragraph.
        expect(children).toHaveLength(2);
        expect(children[1].getTextContent()).toBe('abcHellodef');
      });
    });

    test('copying part of a paragraph still yields inline content only', async () => {
      const {editor} = testEnv;
      await editor.update(() => {
        const root = $getRoot();
        root.clear();
        const first = $createParagraphNode();
        first.setFormat('center');
        const text = $createTextNode('Hello');
        first.append(text);
        root.append(first);
        const selection = $createRangeSelection();
        // Only "ell" is selected, so this is a fragment of a line, not a block.
        selection.anchor.set(text.getKey(), 1, 'text');
        selection.focus.set(text.getKey(), 4, 'text');
        $setSelection(selection);
      });

      editor.read(() => {
        const selection = $getSelection();
        invariant($isRangeSelection(selection), 'Expected RangeSelection');
        const {nodes} = $generateJSONFromSelectedNodes(editor, selection);
        expect(nodes).toHaveLength(1);
        expect(nodes[0].type).toBe('text');
        expect($getHtmlContent(editor, selection)).toBe(
          '<span style="white-space: pre-wrap;">ell</span>',
        );
      });
    });
  });
});
