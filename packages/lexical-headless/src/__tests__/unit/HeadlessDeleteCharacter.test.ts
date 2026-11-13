/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node
import {createHeadlessEditor} from '@lexical/headless';
import {
  $createQuoteNode,
  QuoteNode,
  registerRichText,
} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  DELETE_CHARACTER_COMMAND,
} from 'lexical';
import {describe, expect, test} from 'vitest';

function $children() {
  return $getRoot()
    .getChildren()
    .map(node => [node.getType(), node.getTextContent()]);
}

describe('DELETE_CHARACTER_COMMAND in a headless editor (no DOM)', () => {
  test.each([
    ['is the first block', false, [['paragraph', 'quote']]],
    ['follows a paragraph', true, [['paragraph', 'beforequote']]],
  ] as const)(
    'backspace at the start of a quote that %s',
    (_name, withPreviousParagraph, expected) => {
      expect(typeof document).toBe('undefined');
      const editor = createHeadlessEditor({
        nodes: [QuoteNode],
        onError: error => {
          throw error;
        },
      });
      const unregister = registerRichText(editor);
      editor.update(
        () => {
          if (withPreviousParagraph) {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('before')),
            );
          }
          const quote = $createQuoteNode().append($createTextNode('quote'));
          $getRoot().append(quote);
          quote.selectStart();
        },
        {discrete: true},
      );

      expect(() =>
        editor.update(
          () => {
            editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
          },
          {discrete: true},
        ),
      ).not.toThrow();
      expect(editor.read($children)).toEqual(expected);
      unregister();
    },
  );
});
