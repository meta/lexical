/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$isCodeNode} from '@lexical/code-core';
import {
  $isHorizontalRuleNode,
  type AnyLexicalExtensionArgument,
  buildEditorFromExtensions,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {$isLinkNode} from '@lexical/link';
import {$isListItemNode, $isListNode} from '@lexical/list';
import {$isHeadingNode, $isQuoteNode} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $getState,
  $isElementNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  configExtension,
  defineExtension,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  UNDO_COMMAND,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {describe, expect, it} from 'vitest';

import {
  $convertToMarkdownString,
  MdastCommonMarkExtension,
  MdastExtension,
  MdastGfmExtension,
  MdastRichTextExtension,
  MdastShortcutsExtension,
} from '../../index';
import {codeFenceState, codeMetaState} from '../../state';

function createEditor(
  ...extensions: AnyLexicalExtensionArgument[]
): LexicalEditorWithDispose {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        MdastCommonMarkExtension,
        MdastGfmExtension,
        MdastShortcutsExtension,
        ...extensions,
      ],
      name: '[root]',
    }),
  );
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      root.append(paragraph);
      paragraph.selectEnd();
    },
    {discrete: true},
  );
  return editor;
}

/** Types each chunk in its own discrete update, firing the shortcut listener. */
function type(editor: LexicalEditor, chunks: string[]): void {
  for (const chunk of chunks) {
    editor.update(
      () => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText(chunk);
        }
      },
      {discrete: true},
    );
  }
}

describe('@lexical/mdast streaming shortcuts', () => {
  /** Asserts the root's first child matches the guard, inside a read. */
  function $expectFirstChild<T extends LexicalNode>(
    editor: LexicalEditor,
    $guard: (value: LexicalNode | null) => value is T,
  ): void {
    editor.read(() => {
      $assertNodeType($getRoot().getFirstChild(), $guard);
    });
  }

  describe('block shortcuts (on space)', () => {
    it('# -> heading', () => {
      using editor = createEditor();
      type(editor, ['#', ' ']);
      editor.read(() => {
        const heading = $assertNodeType(
          $getRoot().getFirstChild(),
          $isHeadingNode,
        );
        expect(heading.getTag()).toBe('h1');
      });
    });

    it('### -> heading level 3', () => {
      using editor = createEditor();
      type(editor, ['##', '#', ' ']);
      editor.read(() => {
        const heading = $assertNodeType(
          $getRoot().getFirstChild(),
          $isHeadingNode,
        );
        expect(heading.getTag()).toBe('h3');
      });
    });

    it('> -> quote', () => {
      using editor = createEditor();
      type(editor, ['>', ' ']);
      $expectFirstChild(editor, $isQuoteNode);
    });

    it('- -> bullet list', () => {
      using editor = createEditor();
      type(editor, ['-', ' ']);
      editor.read(() => {
        const list = $assertNodeType($getRoot().getFirstChild(), $isListNode);
        expect(list.getListType()).toBe('bullet');
      });
    });

    it('1. -> ordered list', () => {
      using editor = createEditor();
      type(editor, ['1', '.', ' ']);
      editor.read(() => {
        const list = $assertNodeType($getRoot().getFirstChild(), $isListNode);
        expect(list.getListType()).toBe('number');
      });
    });

    it('- [ ] -> check list', () => {
      using editor = createEditor();
      type(editor, ['-', ' ', '[', ' ', ']', ' ']);
      editor.read(() => {
        const list = $assertNodeType($getRoot().getFirstChild(), $isListNode);
        expect(list.getListType()).toBe('check');
      });
    });

    it('- [x] -> checked check list item', () => {
      using editor = createEditor();
      type(editor, ['-', ' ', '[', 'x', ']', ' ']);
      editor.read(() => {
        const list = $assertNodeType($getRoot().getFirstChild(), $isListNode);
        expect(list.getListType()).toBe('check');
        const item = list.getFirstChild();
        expect($isListItemNode(item) && item.getChecked()).toBe(true);
      });
    });

    it('- [] does not become a check list (GFM requires one character)', () => {
      using editor = createEditor();
      type(editor, ['-', ' ', '[', ']', ' ']);
      editor.read(() => {
        const list = $assertNodeType($getRoot().getFirstChild(), $isListNode);
        expect(list.getListType()).toBe('bullet');
      });
    });
  });

  // `> ## H2` imports as a QuoteNode holding a HeadingNode, so typing the
  // same markers has to build the same tree instead of leaving the marker as
  // literal text inside the quote.
  describe('block shortcuts inside a quote (#7407)', () => {
    it('## -> heading nested in the quote', () => {
      using editor = createEditor();
      type(editor, ['>', ' ', '#', '#', ' ', 'H2']);
      editor.read(() => {
        const quote = $assertNodeType($getRoot().getFirstChild(), $isQuoteNode);
        const heading = $assertNodeType(quote.getFirstChild(), $isHeadingNode);
        expect(heading.getTag()).toBe('h2');
        expect(heading.getTextContent()).toBe('H2');
        expect(quote.getChildrenSize()).toBe(1);
        // A quote may only hold block children as a shadow root.
        expect(quote.isShadowRoot()).toBe(true);
      });
    });

    it('- -> bullet list nested in the quote', () => {
      using editor = createEditor();
      type(editor, ['>', ' ', '-', ' ', 'a']);
      editor.read(() => {
        const quote = $assertNodeType($getRoot().getFirstChild(), $isQuoteNode);
        const list = $assertNodeType(quote.getFirstChild(), $isListNode);
        expect(list.getListType()).toBe('bullet');
        expect(list.getTextContent()).toBe('a');
      });
    });

    it('1. -> ordered list nested in the quote', () => {
      using editor = createEditor();
      type(editor, ['>', ' ', '1', '.', ' ', 'a']);
      editor.read(() => {
        const quote = $assertNodeType($getRoot().getFirstChild(), $isQuoteNode);
        const list = $assertNodeType(quote.getFirstChild(), $isListNode);
        expect(list.getListType()).toBe('number');
        expect(list.getTextContent()).toBe('a');
      });
    });

    it('Enter keeps an indented line in the quote as text', () => {
      using editor = createEditor();
      type(editor, ['>', ' ', '    indented line']);
      editor.dispatchCommand(KEY_ENTER_COMMAND, null);
      editor.read(() => {
        const quote = $assertNodeType($getRoot().getFirstChild(), $isQuoteNode);
        expect(quote.getChildren().some($isCodeNode)).toBe(false);
        expect(quote.getTextContent()).toBe('    indented line');
      });
    });

    it('```js + Enter -> code block nested in the quote', () => {
      using editor = createEditor();
      type(editor, ['>', ' ', '```js']);
      editor.dispatchCommand(KEY_ENTER_COMMAND, null);
      editor.read(() => {
        const quote = $assertNodeType($getRoot().getFirstChild(), $isQuoteNode);
        const code = $assertNodeType(quote.getFirstChild(), $isCodeNode);
        expect(code.getLanguage()).toBe('js');
        expect(code.getTextContent()).toBe('');
      });
    });

    it('--- -> horizontal rule nested in the quote', () => {
      using editor = createEditor();
      type(editor, ['>', ' ', '-', '-', '-', ' ', 'after']);
      editor.read(() => {
        const quote = $assertNodeType($getRoot().getFirstChild(), $isQuoteNode);
        expect(quote.isShadowRoot()).toBe(true);
        const [rule, next, ...rest] = quote.getChildren();
        $assertNodeType(rule, $isHorizontalRuleNode);
        const paragraph = $assertNodeType(next, $isParagraphNode);
        expect(paragraph.getTextContent()).toBe('after');
        expect(rest).toEqual([]);
        expect($convertToMarkdownString()).toBe('> ---\n>\n> after');
      });
    });

    it('leaves the quote alone once it holds a block', () => {
      using editor = createEditor();
      type(editor, ['>', ' ', '#', ' ', 'A']);
      editor.read(() => {
        const quote = $assertNodeType($getRoot().getFirstChild(), $isQuoteNode);
        $assertNodeType(quote.getFirstChild(), $isHeadingNode);
      });
      // The caret sits in the heading, which is not the quote's leading text,
      // so a second marker must stay literal rather than restructure anything.
      type(editor, [' ', '#', '#', ' ']);
      editor.read(() => {
        const quote = $assertNodeType($getRoot().getFirstChild(), $isQuoteNode);
        expect(quote.getChildrenSize()).toBe(1);
        const heading = $assertNodeType(quote.getFirstChild(), $isHeadingNode);
        expect(heading.getTag()).toBe('h1');
        expect(heading.getTextContent()).toBe('A ## ');
      });
    });
  });

  describe('inline shortcuts (on closing delimiter)', () => {
    function inlineFormats(editor: LexicalEditor): number[] {
      return editor.read(() => {
        const element = $assertNodeType(
          $getRoot().getFirstChild(),
          $isElementNode,
        );
        return element
          .getChildren()
          .map(n => ($isTextNode(n) ? n.getFormat() : 0));
      });
    }

    it('**bold** applies bold', () => {
      using editor = createEditor();
      type(editor, ['**bold*', '*']);
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('bold');
      });
      expect(inlineFormats(editor).some(f => f !== 0)).toBe(true);
    });

    it('*italic* applies italic', () => {
      using editor = createEditor();
      type(editor, ['*italic', '*']);
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('italic');
      });
      expect(inlineFormats(editor).some(f => f !== 0)).toBe(true);
    });

    it('`code` applies code', () => {
      using editor = createEditor();
      type(editor, ['`code', '`']);
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('code');
      });
      expect(inlineFormats(editor).some(f => f !== 0)).toBe(true);
    });

    it('~~strike~~ applies strikethrough', () => {
      using editor = createEditor();
      type(editor, ['~~strike~', '~']);
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('strike');
      });
      expect(inlineFormats(editor).some(f => f !== 0)).toBe(true);
    });

    it('[text](url) becomes a link', () => {
      using editor = createEditor();
      type(editor, ['[lexical](https://lexical.dev', ')']);
      editor.read(() => {
        const element = $assertNodeType(
          $getRoot().getFirstChild(),
          $isElementNode,
        );
        const link = element.getChildren().find($isLinkNode);
        expect(link).toBeDefined();
        expect(link!.getURL()).toBe('https://lexical.dev');
        expect(link!.getTextContent()).toBe('lexical');
      });
    });

    it('only fires when the closing delimiter is at the caret', () => {
      using editor = createEditor();
      // A lone opening delimiter must not transform anything.
      type(editor, ['*not italic']);
      $expectFirstChild(editor, $isParagraphNode);
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('*not italic');
      });
    });
  });

  describe('fenced code (on Enter)', () => {
    it('```js + Enter -> empty code block with the language', () => {
      using editor = createEditor();
      type(editor, ['```js']);
      editor.dispatchCommand(KEY_ENTER_COMMAND, null);
      editor.read(() => {
        const code = $assertNodeType($getRoot().getFirstChild(), $isCodeNode);
        expect(code.getLanguage()).toBe('js');
        // The fence line is entirely marker; no literal '```js' may leak in.
        expect(code.getTextContent()).toBe('');
      });
    });

    it('a fence indented up to three spaces still converts', () => {
      using editor = createEditor();
      type(editor, ['   ```js']);
      editor.dispatchCommand(KEY_ENTER_COMMAND, null);
      editor.read(() => {
        const code = $assertNodeType($getRoot().getFirstChild(), $isCodeNode);
        expect(code.getLanguage()).toBe('js');
        expect(code.getTextContent()).toBe('');
      });
    });

    it('```js title=x + Enter keeps the info-string meta and fence', () => {
      using editor = createEditor();
      type(editor, ['~~~js title=x']);
      editor.dispatchCommand(KEY_ENTER_COMMAND, null);
      editor.read(() => {
        const code = $assertNodeType($getRoot().getFirstChild(), $isCodeNode);
        expect(code.getLanguage()).toBe('js');
        expect($getState(code, codeMetaState)).toBe('title=x');
        expect($getState(code, codeFenceState)).toBe('~~~');
      });
    });
  });

  describe('horizontal rule (on space or Enter)', () => {
    /**
     * Asserts the root holds a rule and then the paragraph the caret moved
     * to, and that the rule is exported with the marker it was typed with.
     */
    function expectRuleThenLine(editor: LexicalEditor, marker: string): void {
      editor.read(() => {
        const [rule, next, ...rest] = $getRoot().getChildren();
        $assertNodeType(rule, $isHorizontalRuleNode);
        const paragraph = $assertNodeType(next, $isParagraphNode);
        expect(paragraph.getTextContent()).toBe('after');
        expect(rest).toEqual([]);
        expect($convertToMarkdownString()).toBe(`${marker}\n\nafter`);
      });
    }

    describe.each(['---', '***', '___'])('%s', marker => {
      it('+ space -> horizontal rule, caret on a new line under it', () => {
        using editor = createEditor();
        type(editor, [...marker, ' ', 'after']);
        expectRuleThenLine(editor, marker);
      });

      it('+ Enter -> horizontal rule, caret on a new line under it', () => {
        using editor = createEditor();
        type(editor, [...marker]);
        editor.dispatchCommand(KEY_ENTER_COMMAND, null);
        type(editor, ['after']);
        expectRuleThenLine(editor, marker);
      });
    });

    it('-- + Enter stays text', () => {
      using editor = createEditor();
      type(editor, ['-', '-']);
      editor.dispatchCommand(KEY_ENTER_COMMAND, null);
      editor.read(() => {
        const paragraph = $assertNodeType(
          $getRoot().getFirstChild(),
          $isParagraphNode,
        );
        expect(paragraph.getTextContent()).toBe('--');
        expect($getRoot().getChildren().some($isHorizontalRuleNode)).toBe(
          false,
        );
      });
    });

    it('a space typed between --- and text converts nothing', () => {
      using editor = createEditor();
      // `--- after` is a paragraph in Markdown, not a rule followed by text,
      // even though the text up to the caret (`--- `) is a rule.
      editor.update(
        () => {
          const paragraph = $createParagraphNode();
          const text = $createTextNode('---after');
          paragraph.append(text);
          $getRoot().clear().append(paragraph);
          text.select(3, 3);
        },
        {discrete: true},
      );
      type(editor, [' ']);
      $expectFirstChild(editor, $isParagraphNode);
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('--- after');
      });
    });

    it.each([
      ['space', ' '],
      ['Enter', null],
    ])('--- + %s in a table cell stays text', (_key, key) => {
      using editor = createEditor();
      // A cell has no Markdown for a rule: the table export would write it
      // after the table.
      editor.update(
        () => {
          const paragraph = $createParagraphNode();
          $getRoot()
            .clear()
            .append(
              $createTableNode().append(
                $createTableRowNode().append(
                  $createTableCellNode().append(paragraph),
                ),
              ),
            );
          paragraph.select();
        },
        {discrete: true},
      );
      type(editor, ['-', '-', '-']);
      if (key === null) {
        editor.dispatchCommand(KEY_ENTER_COMMAND, null);
      } else {
        type(editor, [key]);
      }
      editor.read(() => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        const row = $assertNodeType(table.getFirstChild(), $isTableRowNode);
        const cell = $assertNodeType(row.getFirstChild(), $isTableCellNode);
        expect(cell.getChildren().some($isHorizontalRuleNode)).toBe(false);
        expect(cell.getTextContent()).toContain('---');
      });
    });

    /** Presses space (`' '`) or Enter (`null`). */
    function press(editor: LexicalEditor, key: ' ' | null): void {
      if (key === null) {
        editor.dispatchCommand(KEY_ENTER_COMMAND, null);
      } else {
        type(editor, [key]);
      }
    }

    function $expectNoRule(): void {
      expect($getRoot().getChildren().some($isHorizontalRuleNode)).toBe(false);
    }

    it.each([
      ['space', ' '],
      ['Enter', null],
    ] as const)('a rule longer than 24 characters converts on %s', (_, key) => {
      using editor = createEditor();
      type(editor, [...'-'.repeat(30)]);
      press(editor, key);
      type(editor, ['after']);
      expectRuleThenLine(editor, '---');
    });

    it.each([
      ['space', ' ', '--- '],
      ['Enter', null, '---'],
    ] as const)('undo after %s gives back the typed marker', (_, key, text) => {
      using editor = createEditor(
        // History is off by default where there is no window.
        configExtension(HistoryExtension, {disabled: false}),
      );
      type(editor, ['-', '-', '-']);
      press(editor, key);
      $expectFirstChild(editor, $isHorizontalRuleNode);
      editor.dispatchCommand(UNDO_COMMAND, undefined);
      editor.read(() => {
        const [paragraph, ...rest] = $getRoot().getChildren();
        expect(
          $assertNodeType(paragraph, $isParagraphNode).getTextContent(),
        ).toBe(text);
        expect(rest).toEqual([]);
      });
    });

    it.each([
      ['space', ' '],
      ['Enter', null],
    ] as const)('--- + %s in a code block stays code', (_, key) => {
      using editor = createEditor();
      type(editor, ['```']);
      editor.dispatchCommand(KEY_ENTER_COMMAND, null);
      type(editor, ['-', '-', '-']);
      press(editor, key);
      editor.read(() => {
        const code = $assertNodeType($getRoot().getFirstChild(), $isCodeNode);
        expect(code.getTextContent()).toMatch(/^---/);
        $expectNoRule();
      });
    });

    it.each([
      ['space', ' '],
      ['Enter', null],
    ] as const)('--- + %s in inline code stays text', (_, key) => {
      using editor = createEditor();
      editor.update(
        () => {
          const text = $createTextNode('---').toggleFormat('code');
          $getRoot().clear().append($createParagraphNode().append(text));
          text.selectEnd();
        },
        {discrete: true},
      );
      press(editor, key);
      editor.read(() => {
        expect($getRoot().getTextContent()).toMatch(/^---/);
        $expectNoRule();
      });
    });

    it('--- + Shift+Enter stays text', () => {
      using editor = createEditor();
      type(editor, ['-', '-', '-']);
      editor.dispatchCommand(KEY_ENTER_COMMAND, {
        preventDefault() {},
        shiftKey: true,
      } as KeyboardEvent);
      editor.read(() => {
        expect($getRoot().getTextContent()).toMatch(/^---/);
        $expectNoRule();
      });
    });

    it.each([
      ['space', ' '],
      ['Enter', null],
    ] as const)(
      '--- + %s stays text when the editor has no HorizontalRuleNode',
      (_, key) => {
        const errors: Error[] = [];
        // An editor that imports `thematicBreak` as its own node, without
        // HorizontalRuleExtension.
        using editor = buildEditorFromExtensions(
          defineExtension({
            dependencies: [
              MdastRichTextExtension,
              configExtension(MdastExtension, {
                importRules: [
                  {
                    $import: () => $createParagraphNode(),
                    type: 'thematicBreak',
                  },
                ],
              }),
              MdastShortcutsExtension,
            ],
            name: '[no horizontal rule]',
            onError: error => {
              errors.push(error);
            },
          }),
        );
        editor.update(
          () => {
            const paragraph = $createParagraphNode();
            $getRoot().clear().append(paragraph);
            paragraph.select();
          },
          {discrete: true},
        );
        type(editor, ['-', '-', '-']);
        press(editor, key);
        expect(errors).toEqual([]);
        editor.read(() => {
          expect($getRoot().getTextContent()).toMatch(/^---/);
        });
      },
    );
  });

  describe('does not fire destructively', () => {
    it('Enter does not convert a line with content after the marker', () => {
      using editor = createEditor();
      // '# Title' inserted in one operation (paste-like), then Enter. The
      // heading shortcut already had its chance at the space; Enter on a
      // line with content must not re-convert it (undo-escape hatch).
      type(editor, ['# Title']);
      editor.dispatchCommand(KEY_ENTER_COMMAND, null);
      $expectFirstChild(editor, $isParagraphNode);
      editor.read(() => {
        expect($getRoot().getTextContent()).toContain('# Title');
      });
    });

    it('Enter does not convert prose that happens to parse as a list', () => {
      using editor = createEditor();
      type(editor, ['2024. was a big year']);
      editor.dispatchCommand(KEY_ENTER_COMMAND, null);
      $expectFirstChild(editor, $isParagraphNode);
    });

    it.each([
      ['four spaces', '    indented line'],
      ['a tab', '\tindented line'],
    ])('Enter keeps a line indented with %s as text', (_, line) => {
      using editor = createEditor();
      // Four columns of indentation parse as indented code, which has no
      // marker: Enter must not replace the line with an empty code block.
      type(editor, [line]);
      editor.dispatchCommand(KEY_ENTER_COMMAND, null);
      $expectFirstChild(editor, $isParagraphNode);
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe(line);
      });
    });

    it('multi-character insertion (paste) does not transform', () => {
      using editor = createEditor();
      type(editor, ['see *note*']);
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('see *note*');
      });
    });

    it('deleting back to a delimiter does not transform', () => {
      using editor = createEditor();
      type(editor, ['*a*b']);
      // Simulate backspace: the trailing character is removed and the caret
      // lands right after the closing '*'.
      editor.update(
        () => {
          const paragraph = $assertNodeType(
            $getRoot().getFirstChild(),
            $isElementNode,
          );
          const text = paragraph.getFirstChild();
          if ($isTextNode(text)) {
            text.setTextContent('*a*');
            text.select(3, 3);
          }
        },
        {discrete: true},
      );
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('*a*');
      });
    });

    it('does not transform inside an inline code span', () => {
      using editor = createEditor();
      editor.update(
        () => {
          const paragraph = $createParagraphNode();
          const text = $createTextNode('use *args');
          text.setFormat('code');
          paragraph.append(text);
          $getRoot().clear().append(paragraph);
          text.selectEnd();
        },
        {discrete: true},
      );
      type(editor, ['*']);
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('use *args*');
        const paragraph = $assertNodeType(
          $getRoot().getFirstChild(),
          $isElementNode,
        );
        const first = paragraph.getFirstChild();
        expect($isTextNode(first) && first.hasFormat('code')).toBe(true);
      });
    });

    it('block markers wrapped in inline formatting keep their delimiters', () => {
      using editor = createEditor();
      // '# **bold** title' + space typed after '#' converts to a heading; the
      // heading itself is exercised elsewhere. Here: pasting the full line
      // and pressing Enter must not strip the '**'.
      type(editor, ['# **bold** title']);
      editor.dispatchCommand(KEY_ENTER_COMMAND, null);
      editor.read(() => {
        expect($getRoot().getTextContent()).toContain('**bold** title');
      });
    });
  });
});
