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
  $createTextNode,
  $getRoot,
  $getSelection,
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
  });
});
