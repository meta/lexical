/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$createCodeNode} from '@lexical/code';
import {registerCodeHighlighting} from '@lexical/code-prism';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
} from 'lexical';
import {initializeUnitTest} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

describe('CodeHighlighterPrism $updateAndRetainSelection', () => {
  initializeUnitTest(testEnv => {
    test.each([
      ['\nfoo', 'X\nfoo'],
      ['\n\nfoo', 'X\n\nfoo'],
      ['foo\nbar', 'Xfoo\nbar'],
    ])(
      'retains a non-negative offset for code content %j (#8943)',
      async (codeText, expectedText) => {
        const {editor} = testEnv;
        registerCodeHighlighting(editor);

        await editor.update(() => {
          const code = $createCodeNode('javascript');
          $getRoot().clear().append(code);
          code.append($createTextNode(codeText));
          // Caret at the very start of the code block, while its content is
          // still un-flattened, so the highlighting transform has to restore it.
          code.select(0, 0);
        });

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

        await editor.update(() => {
          const selection = $getSelection();
          expect($isRangeSelection(selection)).toBe(true);
          if ($isRangeSelection(selection)) {
            selection.insertText('X');
          }
        });

        expect(
          editor.read(() => $getRoot().getFirstChild()!.getTextContent()),
        ).toBe(expectedText);
      },
    );

    // An element point after a line break is a child index, which goes
    // stale when the highlighter splits an earlier line into more tokens.
    // The caret must stay on its own line.
    test.each([
      [['const a = 1', '\n', 'b'], 2, 'const a = 1\nXb'],
      [['const a = 1', '\n'], 2, 'const a = 1\nX'],
      [['const a = 1', '\n', '\n', 'b'], 3, 'const a = 1\n\nXb'],
      [['\n', 'const a = 1'], 0, 'X\nconst a = 1'],
    ])(
      'keeps an element caret on its line when an earlier line is split: %j at %i',
      async (parts, offset, expectedText) => {
        const {editor} = testEnv;
        registerCodeHighlighting(editor);

        await editor.update(() => {
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
        });
        expect(
          editor.read(() => {
            const code = $getRoot().getLastChild();
            return $isElementNode(code) ? code.getChildrenSize() : 0;
          }),
        ).toBeGreaterThan(parts.length);

        await editor.update(() => {
          const selection = $getSelection();
          expect($isRangeSelection(selection)).toBe(true);
          if ($isRangeSelection(selection)) {
            selection.insertText('X');
          }
        });

        expect(
          editor.read(() => $getRoot().getLastChild()!.getTextContent()),
        ).toBe(expectedText);
      },
    );

    test('keeps the focus of a range from a paragraph above', async () => {
      const {editor} = testEnv;
      registerCodeHighlighting(editor);

      await editor.update(() => {
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
      });

      editor.read(() => {
        const selection = $getSelection();
        expect($isRangeSelection(selection)).toBe(true);
        expect(selection!.getTextContent()).toBe('ove\nconst a = 1\nlet');
      });
    });
  });
});
