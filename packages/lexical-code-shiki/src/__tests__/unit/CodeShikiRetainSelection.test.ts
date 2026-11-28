/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$createCodeNode} from '@lexical/code';
import {$isCodeNode} from '@lexical/code-core';
import {
  CodeShikiExtension,
  loadCodeLanguage,
  loadCodeTheme,
} from '@lexical/code-shiki';
import {buildEditorFromExtensions} from '@lexical/extension';
import {$convertFromMarkdownString, TRANSFORMERS} from '@lexical/markdown';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  defineExtension,
} from 'lexical';
import {beforeAll, describe, expect, test} from 'vitest';

function createEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [RichTextExtension, CodeShikiExtension],
      name: 'code-shiki-retain-selection-test',
    }),
  );
}

describe('CodeHighlighterShiki $updateAndRetainSelection', () => {
  beforeAll(async () => {
    // Shiki defers highlighting until the grammar and theme have loaded, so
    // load them up front to make the transform run on the first update.
    await loadCodeLanguage('javascript');
    await loadCodeTheme('one-light');
  });

  test.each([
    ['\nfoo', 'X\nfoo'],
    ['\n\nfoo', 'X\n\nfoo'],
    ['foo\nbar', 'Xfoo\nbar'],
  ])(
    'retains a non-negative offset for code content %j (#8943)',
    (codeText, expectedText) => {
      using editor = createEditor();

      editor.update(
        () => {
          const code = $createCodeNode('javascript');
          $getRoot().clear().append(code);
          code.append($createTextNode(codeText));
          // Caret at the very start of the code block, while its content is
          // still un-flattened, so the highlighting transform has to restore it.
          code.select(0, 0);
        },
        {discrete: true},
      );

      editor.read(() => {
        const selection = $getSelection();
        expect($isRangeSelection(selection)).toBe(true);
        if (!$isRangeSelection(selection)) {
          return;
        }
        for (const point of [selection.anchor, selection.focus]) {
          expect(point.offset).toBeGreaterThanOrEqual(0);
          if (point.type === 'text') {
            expect(point.offset).toBeLessThanOrEqual(
              point.getNode().getTextContentSize(),
            );
          }
        }
      });

      editor.update(
        () => {
          const selection = $getSelection();
          expect($isRangeSelection(selection)).toBe(true);
          if ($isRangeSelection(selection)) {
            selection.insertText('X');
          }
        },
        {discrete: true},
      );

      expect(
        editor.read(() => $getRoot().getFirstChild()!.getTextContent()),
      ).toBe(expectedText);
    },
  );

  // An element point after a line break is a child index, which goes stale
  // when the highlighter splits an earlier line into more tokens, e.g. when
  // the grammar loads after Enter. The caret must stay on its own line.
  test.each([
    [['const a = 1', '\n', 'b'], 2, 'const a = 1\nXb'],
    [['const a = 1', '\n'], 2, 'const a = 1\nX'],
    [['const a = 1', '\n', '\n', 'b'], 3, 'const a = 1\n\nXb'],
    [['\n', 'const a = 1'], 0, 'X\nconst a = 1'],
  ])(
    'keeps an element caret on its line when an earlier line is split: %j at %i',
    (parts, offset, expectedText) => {
      using editor = createEditor();

      editor.update(
        () => {
          const code = $createCodeNode('javascript');
          // Text before the code block must not count toward the caret.
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append($createTextNode('x'.repeat(50))),
              code,
            );
          code.append(
            ...parts.map(part =>
              part === '\n' ? $createLineBreakNode() : $createTextNode(part),
            ),
          );
          code.select(offset, offset);
        },
        {discrete: true},
      );
      expect(
        editor.read(() => {
          const code = $getRoot().getLastChild();
          return $isElementNode(code) ? code.getChildrenSize() : 0;
        }),
      ).toBeGreaterThan(parts.length);

      editor.update(
        () => {
          const selection = $getSelection();
          expect($isRangeSelection(selection)).toBe(true);
          if ($isRangeSelection(selection)) {
            selection.insertText('X');
          }
        },
        {discrete: true},
      );

      expect(
        editor.read(() => $getRoot().getLastChild()!.getTextContent()),
      ).toBe(expectedText);
    },
  );
});

test('CodeHighlighterShiki keeps the focus of a range from a paragraph above', async () => {
  await loadCodeLanguage('javascript');
  await loadCodeTheme('one-light');
  using editor = createEditor();

  editor.update(
    () => {
      const above = $createTextNode('above');
      const last = $createTextNode('let b = 2');
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append(above),
          $createCodeNode('javascript').append(
            $createTextNode('const a = 1'),
            $createLineBreakNode(),
            last,
          ),
        );
      above.select(2, 2).focus.set(last.getKey(), 3, 'text');
    },
    {discrete: true},
  );

  editor.read(() => {
    const selection = $getSelection();
    expect($isRangeSelection(selection)).toBe(true);
    expect(selection!.getTextContent()).toBe('ove\nconst a = 1\nlet');
  });
});

/**
 * Shiki loads grammars and themes asynchronously, so the highlight transform
 * that rewrites the code block's children only runs once those settle.
 */
async function settleHighlighting(): Promise<void> {
  await loadCodeLanguage('javascript');
  await loadCodeTheme('one-light');
  await Promise.resolve();
}

function $describeCaret() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return {selection: String(selection)};
  }
  const anchorNode = selection.anchor.getNode();
  return {
    blocks: $getRoot()
      .getChildren()
      .map(child => child.getType()),
    inCodeBlock:
      $isCodeNode(anchorNode) || anchorNode.getParents().some($isCodeNode),
    offset: selection.anchor.offset,
    text: anchorNode.getTextContent(),
  };
}

/**
 * $convertFromMarkdownString only moves the caret when there already is one,
 * which is the case when a user pastes markdown into a focused editor.
 */
function $seedSelection(): void {
  const paragraph = $createParagraphNode();
  $getRoot().clear().append(paragraph);
  paragraph.selectEnd();
}

describe('Shiki highlighting only retains a selection it owns (#6305)', () => {
  test('importing markdown that ends in a code block leaves the caret at the document start', async () => {
    using editor = createEditor();

    editor.update($seedSelection, {discrete: true});
    editor.update(
      () => {
        $convertFromMarkdownString(
          'hello world\n\n```\necho hello world\n```',
          TRANSFORMERS,
        );
      },
      {discrete: true},
    );
    await settleHighlighting();

    expect(editor.read($describeCaret)).toEqual({
      blocks: ['paragraph', 'code'],
      inCodeBlock: false,
      offset: 0,
      text: 'hello world',
    });
  });

  test('the caret is not dragged into the last of several imported code blocks', async () => {
    using editor = createEditor();

    editor.update($seedSelection, {discrete: true});
    editor.update(
      () => {
        $convertFromMarkdownString(
          'hello world\n\n```\nfirst\n```\n\nmiddle\n\n```\nlast\n```',
          TRANSFORMERS,
        );
      },
      {discrete: true},
    );
    await settleHighlighting();

    expect(editor.read($describeCaret)).toEqual({
      blocks: ['paragraph', 'code', 'paragraph', 'code'],
      inCodeBlock: false,
      offset: 0,
      text: 'hello world',
    });
  });
});
