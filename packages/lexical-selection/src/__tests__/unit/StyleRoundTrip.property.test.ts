/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// `$patchStyle` parses a style with `getStyleObjectFromCSS`, changes the
// object, and writes it back with `getCSSFromStyleObject`. Property test,
// with fast-check, over styles of up to three declarations whose values are
// built from pieces that are easy to get wrong (quotes, parentheses,
// comments, `;`, `:`, backslashes), well formed or not:
//
// - parsing what was written gives back what was parsed;
// - a patched property reads back with its new value, and the others keep
//   theirs;
// - patching again with the same value writes the same string.
//
// The default run is small. Set STYLE_ROUND_TRIP_RUNS to run more; a comment
// between `/` and `*` (see setDOMStyle.test.ts) turns up in fewer than one
// style in a thousand.

import {buildEditorFromExtensions} from '@lexical/extension';
import {$patchStyleText, getCSSFromStyleObject} from '@lexical/selection';
import * as fc from 'fast-check';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  getStyleObjectFromCSS,
} from 'lexical';
import {describe, expect, test} from 'vitest';

const RUNS = Number(process.env.STYLE_ROUND_TRIP_RUNS || 200);

const VALUE_PIECES = [
  'red',
  'Arial',
  '"Courier New"',
  "'A'",
  '12px',
  'url(a.png)',
  'calc(1px + 2px)',
  '!important',
  '"',
  "'",
  '(',
  ')',
  ';',
  ':',
  ' ',
  '\\',
  '/*c*/',
  '/*',
  '*/',
  '/',
  '*',
];

const declarationArbitrary = fc
  .tuple(
    fc.constantFrom('color', 'font-family', 'margin'),
    fc.array(fc.constantFrom(...VALUE_PIECES), {maxLength: 6}),
  )
  .map(([property, pieces]) => `${property}: ${pieces.join('')}`);

const styleArbitrary = fc
  .array(declarationArbitrary, {maxLength: 3})
  .map(declarations => declarations.join('; '));

function patch(css: string, key: string, value: string): string {
  return getCSSFromStyleObject({...getStyleObjectFromCSS(css), [key]: value});
}

describe('style round trip', () => {
  test('parsing what was written gives back what was parsed', () => {
    fc.assert(
      fc.property(styleArbitrary, css => {
        const parsed = getStyleObjectFromCSS(css);
        expect(getStyleObjectFromCSS(getCSSFromStyleObject(parsed))).toEqual(
          parsed,
        );
      }),
      {numRuns: RUNS, seed: 42},
    );
  });

  test('a patch reads back, keeps the other properties and is stable', () => {
    fc.assert(
      fc.property(styleArbitrary, css => {
        const parsed = getStyleObjectFromCSS(css);
        const once = patch(css, 'color', 'blue');
        expect(getStyleObjectFromCSS(once)).toEqual({
          ...parsed,
          color: 'blue',
        });
        expect(patch(once, 'color', 'blue')).toBe(once);
      }),
      {numRuns: RUNS, seed: 42},
    );
  });
});

describe('$patchStyleText on a style left open at the end', () => {
  for (const style of ['font-family: "Arial', 'background-image: url(a.png']) {
    test(style, () => {
      using editor = buildEditorFromExtensions({name: 'style-round-trip'});
      editor.update(
        () => {
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('hello').setStyle(style),
            ),
          );
        },
        {discrete: true},
      );
      const styles = [];
      const seen: (string | null)[] = [];
      for (const color of ['red', 'blue', 'blue']) {
        editor.update(
          () => {
            const text = $getRoot().getAllTextNodes()[0];
            $patchStyleText(text.select(0, text.getTextContentSize()), {
              color: current => {
                seen.push(current);
                return color;
              },
            });
          },
          {discrete: true},
        );
        styles.push(
          editor.read(() => $getRoot().getAllTextNodes()[0].getStyle()),
        );
      }
      const [first, second, third] = styles;
      expect(getStyleObjectFromCSS(first).color).toBe('red');
      expect(getStyleObjectFromCSS(second).color).toBe('blue');
      // The patch function sees the color the previous patch wrote.
      expect(seen).toEqual([undefined, 'red', 'blue']);
      expect(third).toBe(second);
    });
  }
});
