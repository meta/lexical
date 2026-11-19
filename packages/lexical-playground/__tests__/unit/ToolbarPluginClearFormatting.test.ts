/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions} from '@lexical/extension';
import {$createHeadingNode, RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  defineExtension,
  type ElementFormatType,
  type ParagraphNode,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

import {clearFormatting} from '../../src/plugins/ToolbarPlugin/utils';

function createEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [RichTextExtension],
      name: 'test',
    }),
  );
}

const $getFirstParagraph = (): ParagraphNode => {
  const paragraph = $getRoot().getFirstChild();
  assert($isParagraphNode(paragraph), 'Expected a ParagraphNode');
  return paragraph;
};

describe('clearFormatting (Toolbar)', () => {
  test('clears text and block formatting when all content is selected', () => {
    using editor = createEditor();
    editor.update(
      () => {
        const text = $createTextNode('Hello World');
        text.toggleFormat('bold');
        const paragraph = $createParagraphNode().append(text);
        paragraph.setFormat('center');
        paragraph.setIndent(1);
        $getRoot().clear().append(paragraph);
        text.select(0, 'Hello World'.length);
      },
      {discrete: true},
    );

    editor.update(() => clearFormatting(editor), {discrete: true});

    editor.read(() => {
      const paragraph = $getFirstParagraph();
      expect(paragraph.getFormatType()).toBe('');
      expect(paragraph.getIndent()).toBe(0);
      const text = paragraph.getFirstChild();
      assert($isTextNode(text), 'Expected a TextNode');
      expect(text.hasFormat('bold')).toBe(false);
    });
  });

  test('keeps block formatting when the selection is partial', () => {
    using editor = createEditor();
    editor.update(
      () => {
        const text = $createTextNode('Hello World');
        text.toggleFormat('bold');
        const paragraph = $createParagraphNode().append(text);
        paragraph.setFormat('center');
        paragraph.setIndent(1);
        $getRoot().clear().append(paragraph);
        text.select(0, 'Hello'.length);
      },
      {discrete: true},
    );

    editor.update(() => clearFormatting(editor), {discrete: true});

    editor.read(() => {
      const paragraph = $getFirstParagraph();
      expect(paragraph.getFormatType()).toBe('center');
      expect(paragraph.getIndent()).toBe(1);
      const [selected, rest] = paragraph.getChildren();
      assert($isTextNode(selected), 'Expected a TextNode');
      assert($isTextNode(rest), 'Expected a TextNode');
      expect(selected.hasFormat('bold')).toBe(false);
      expect(rest.hasFormat('bold')).toBe(true);
    });
  });

  test.each([false, true])(
    'clears only selected text across paragraphs (backward: %s)',
    backward => {
      using editor = createEditor();
      editor.update(
        () => {
          const first = $createTextNode('Foo bar').toggleFormat('bold');
          const second = $createTextNode('baz qux').toggleFormat('bold');
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(first),
              $createParagraphNode().append(second),
            );
          const selection = first.select();
          if (backward) {
            selection.setTextNodeRange(second, 4, first, 4);
          } else {
            selection.setTextNodeRange(first, 4, second, 4);
          }
        },
        {discrete: true},
      );

      editor.update(() => clearFormatting(editor), {discrete: true});

      editor.read(() => {
        expect(
          $getRoot()
            .getChildren()
            .map(paragraph => {
              assert($isParagraphNode(paragraph));
              return paragraph.getAllTextNodes().map(text => ({
                bold: text.hasFormat('bold'),
                text: text.getTextContent(),
              }));
            }),
        ).toEqual([
          [
            {bold: true, text: 'Foo '},
            {bold: false, text: 'bar'},
          ],
          [
            {bold: false, text: 'baz '},
            {bold: true, text: 'qux'},
          ],
        ]);
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        expect(selection.getTextContent()).toBe('bar\nbaz ');
        expect(selection.isBackward()).toBe(backward);
      });
    },
  );

  test('clears block formatting of an empty block with a collapsed selection', () => {
    using editor = createEditor();
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.setFormat('center');
        paragraph.setIndent(1);
        $getRoot().clear().append(paragraph);
        paragraph.select();
      },
      {discrete: true},
    );

    editor.update(() => clearFormatting(editor), {discrete: true});

    editor.read(() => {
      const paragraph = $getFirstParagraph();
      expect(paragraph.getFormatType()).toBe('');
      expect(paragraph.getIndent()).toBe(0);
    });
  });

  test('clears block but not text formatting with a collapsed selection in text (#7383)', () => {
    using editor = createEditor();
    editor.update(
      () => {
        const text = $createTextNode('Hello World');
        text.toggleFormat('bold');
        const paragraph = $createParagraphNode().append(text);
        paragraph.setFormat('right');
        paragraph.setIndent(1);
        $getRoot().clear().append(paragraph);
        text.select('Hello World'.length, 'Hello World'.length);
      },
      {discrete: true},
    );

    editor.update(() => clearFormatting(editor), {discrete: true});

    editor.read(() => {
      const paragraph = $getFirstParagraph();
      expect(paragraph.getFormatType()).toBe('');
      expect(paragraph.getIndent()).toBe(0);
      const text = paragraph.getFirstChild();
      assert($isTextNode(text), 'Expected a TextNode');
      expect(text.hasFormat('bold')).toBe(true);
    });
  });

  test('clears block formatting only for fully selected blocks across paragraphs', () => {
    using editor = createEditor();
    editor.update(
      () => {
        const firstText = $createTextNode('first');
        const secondText = $createTextNode('second');
        const firstParagraph = $createParagraphNode().append(firstText);
        firstParagraph.setFormat('center');
        const secondParagraph = $createParagraphNode().append(secondText);
        secondParagraph.setFormat('right');
        $getRoot().clear().append(firstParagraph, secondParagraph);
        firstText
          .select(0, 0)
          .setTextNodeRange(firstText, 0, secondText, 'sec'.length);
      },
      {discrete: true},
    );

    editor.update(() => clearFormatting(editor), {discrete: true});

    editor.read(() => {
      const [firstParagraph, secondParagraph] = $getRoot().getChildren();
      assert($isParagraphNode(firstParagraph), 'Expected a ParagraphNode');
      assert($isParagraphNode(secondParagraph), 'Expected a ParagraphNode');
      expect(firstParagraph.getFormatType()).toBe('');
      expect(secondParagraph.getFormatType()).toBe('right');
    });
  });

  test('clears block formatting only for fully selected blocks with a backward selection', () => {
    using editor = createEditor();
    editor.update(
      () => {
        const firstText = $createTextNode('first');
        const secondText = $createTextNode('second');
        const firstParagraph = $createParagraphNode().append(firstText);
        firstParagraph.setFormat('center');
        const secondParagraph = $createParagraphNode().append(secondText);
        secondParagraph.setFormat('right');
        $getRoot().clear().append(firstParagraph, secondParagraph);
        firstText
          .select(0, 0)
          .setTextNodeRange(secondText, 'sec'.length, firstText, 0);
      },
      {discrete: true},
    );

    editor.update(() => clearFormatting(editor), {discrete: true});

    editor.read(() => {
      const [firstParagraph, secondParagraph] = $getRoot().getChildren();
      assert($isParagraphNode(firstParagraph), 'Expected a ParagraphNode');
      assert($isParagraphNode(secondParagraph), 'Expected a ParagraphNode');
      expect(firstParagraph.getFormatType()).toBe('');
      expect(secondParagraph.getFormatType()).toBe('right');
    });
  });

  test('handles a selection that starts at an empty heading (#8666)', () => {
    using editor = createEditor();
    editor.update(
      () => {
        const heading = $createHeadingNode('h1');
        const text = $createTextNode('second');
        const paragraph = $createParagraphNode().append(text);
        paragraph.setFormat('right');
        $getRoot().clear().append(heading, paragraph);
        // The anchor is an element point on the heading, which is
        // replaced with a paragraph during clearFormatting
        heading.select(0, 0).focus.set(text.getKey(), 'sec'.length, 'text');
      },
      {discrete: true},
    );

    editor.update(() => clearFormatting(editor), {discrete: true});

    editor.read(() => {
      const [firstParagraph, secondParagraph] = $getRoot().getChildren();
      assert($isParagraphNode(firstParagraph), 'Expected a ParagraphNode');
      assert($isParagraphNode(secondParagraph), 'Expected a ParagraphNode');
      expect(secondParagraph.getFormatType()).toBe('right');
    });
  });

  test('resets the cached selection format so the toolbar updates (#8881)', () => {
    using editor = createEditor();
    // Format a range in the middle of the node, which splits it in three and
    // leaves the selection on the bold node in the middle
    editor.update(
      () => {
        const text = $createTextNode('Hello World');
        $getRoot().clear().append($createParagraphNode().append(text));
        text.select('Hel'.length, 'Hello Wo'.length);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected a RangeSelection');
        selection.formatText('bold');
        selection.setStyle('color: red');
      },
      {discrete: true},
    );

    editor.update(() => clearFormatting(editor), {discrete: true});

    editor.read(() => {
      const selection = $getSelection();
      assert($isRangeSelection(selection), 'Expected a RangeSelection');
      // The toolbars read hasFormat() to decide whether a button is active
      expect(selection.hasFormat('bold')).toBe(false);
      expect(selection.format).toBe(0);
      expect(selection.style).toBe('');
    });
  });

  test('keeps the cached selection format with a collapsed selection (#7383)', () => {
    using editor = createEditor();
    editor.update(
      () => {
        const text = $createTextNode('Hello World');
        text.toggleFormat('bold');
        $getRoot().clear().append($createParagraphNode().append(text));
        // A caret inside bold text carries bold as its pending format, which
        // is what onSelectionChange would sync from the node in the browser
        text
          .select('Hello World'.length, 'Hello World'.length)
          .toggleFormat('bold');
      },
      {discrete: true},
    );

    editor.update(() => clearFormatting(editor), {discrete: true});

    editor.read(() => {
      const selection = $getSelection();
      assert($isRangeSelection(selection), 'Expected a RangeSelection');
      // A collapsed selection only clears block formatting, so the pending
      // text format the user would type with must survive
      expect(selection.hasFormat('bold')).toBe(true);
    });
  });
});

describe.each(['', 'right', 'center', 'justify'] as ElementFormatType[])(
  'clearFormatting alignment %j',
  alignment => {
    test.each([
      [0, false],
      [0, true],
      [2, false],
      [2, true],
    ] as const)(
      'clears indent %s with text formatting %s',
      (indent, formatted) => {
        using editor = createEditor();
        editor.update(
          () => {
            const first = $createTextNode('Hello');
            const second = $createTextNode(' World');
            const third = $createTextNode(' Test');
            if (formatted) {
              second.toggleFormat('bold');
              third
                .toggleFormat('bold')
                .toggleFormat('italic')
                .toggleFormat('underline');
              third.setStyle(
                'color: red; background-color: blue; font-size: 24px;',
              );
            }
            const paragraph = $createParagraphNode().append(
              first,
              second,
              third,
            );
            paragraph.setFormat(alignment);
            paragraph.setIndent(indent);
            $getRoot().clear().append(paragraph);
            paragraph.select(0, paragraph.getChildrenSize());
          },
          {discrete: true},
        );
        editor.update(() => clearFormatting(editor), {discrete: true});
        editor.read(() => {
          const paragraph = $getFirstParagraph();
          expect(paragraph.getFormatType()).toBe('');
          expect(paragraph.getIndent()).toBe(0);
          expect(paragraph.getTextContent()).toBe('Hello World Test');
          const texts = paragraph.getAllTextNodes();
          expect(texts).toHaveLength(1);
          expect(texts[0].getFormat()).toBe(0);
          expect(texts[0].getStyle()).toBe('');
          const selection = $getSelection();
          assert($isRangeSelection(selection));
          expect(selection.format).toBe(0);
          expect(selection.style).toBe('');
        });
      },
    );
  },
);
