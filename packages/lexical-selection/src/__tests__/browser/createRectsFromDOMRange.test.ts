/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {createRectsFromDOMRange} from '@lexical/selection';
import {dedupeSelectionRects} from '@lexical/utils';
import {describe, expect, it, onTestFinished} from 'vitest';

function createRoot(html: string): HTMLDivElement {
  const root = document.createElement('div');
  root.style.cssText =
    'position:absolute;left:20px;top:20px;width:600px;padding:0;font:16px/1.5 Arial';
  root.innerHTML = html;
  document.body.append(root);
  void root.offsetHeight;
  onTestFinished(() => root.remove());
  return root;
}

function expectTextCovered(root: HTMLElement, rects: DOMRect[]): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text;
  while ((text = walker.nextNode())) {
    const range = document.createRange();
    range.selectNodeContents(text);
    for (const rect of range.getClientRects()) {
      if (rect.width === 0 || rect.height === 0) {
        continue;
      }
      for (const horizontal of [0.1, 0.5, 0.9]) {
        for (const vertical of [0.1, 0.5, 0.9]) {
          const x = rect.left + rect.width * horizontal;
          const y = rect.top + rect.height * vertical;
          expect(
            rects.some(
              painted =>
                painted.left <= x &&
                painted.right >= x &&
                painted.top <= y &&
                painted.bottom >= y,
            ),
            `Selection should cover "${text.textContent}" at (${horizontal}, ${vertical})`,
          ).toBe(true);
        }
      }
    }
  }
}

describe('createRectsFromDOMRange with mixed typography', () => {
  it('keeps smaller text before a larger run on the same line', () => {
    const root = createRoot(
      '<span>Small before </span><span style="font-size:40px">large</span><span> small after</span>',
    );
    const range = document.createRange();
    range.selectNodeContents(root);
    const rects = createRectsFromDOMRange({getRootElement: () => root}, range);

    expectTextCovered(root, rects);
    expectTextCovered(root, dedupeSelectionRects(rects));
  });

  it.each([
    ['Arial', 'Trebuchet MS'],
    ['monospace', 'serif'],
  ])('keeps text in different font families: %s and %s', (first, second) => {
    const root = createRoot(
      `<span style="font-family:${first};font-size:32px">First</span><span style="font-family:${second};font-size:32px">Second</span>`,
    );
    const range = document.createRange();
    range.selectNodeContents(root);
    const rects = createRectsFromDOMRange({getRootElement: () => root}, range);

    expectTextCovered(root, rects);
    expectTextCovered(root, dedupeSelectionRects(rects));
  });

  it('keeps the unique area of partially overlapping inline text', () => {
    const root = createRoot(
      '<span>First</span><span style="margin-left:-2px">Second</span>',
    );
    const range = document.createRange();
    range.selectNodeContents(root);
    const rects = createRectsFromDOMRange({getRootElement: () => root}, range);

    expectTextCovered(root, rects);
    expectTextCovered(root, dedupeSelectionRects(rects));
  });

  it('keeps text coverage when an overlapping inline box sits one pixel lower', () => {
    const root = createRoot(
      '<span>Wide selected text</span><span style="display:inline-block;width:12px;height:18px;margin-left:-100px;vertical-align:-1px">N</span>',
    );
    const range = document.createRange();
    range.selectNodeContents(root);

    expectTextCovered(
      root,
      createRectsFromDOMRange({getRootElement: () => root}, range),
    );
  });

  it.each(['ltr', 'rtl'])(
    'keeps mixed-size selections across wrapped %s lines',
    dir => {
      const root = createRoot(
        '<span>Small text before </span><span style="font-size:40px">LARGE TEXT</span><span> and smaller text after.</span>',
      );
      root.dir = dir;
      root.style.width = '200px';
      const range = document.createRange();
      range.selectNodeContents(root);
      const rects = createRectsFromDOMRange(
        {getRootElement: () => root},
        range,
      );

      expect(new Set(rects.map(rect => rect.top)).size).toBeGreaterThan(1);
      expectTextCovered(root, rects);
      expectTextCovered(root, dedupeSelectionRects(rects));
    },
  );

  it('still removes duplicate inline rectangles and full-width block rectangles', () => {
    const root = createRoot(
      '<p style="margin:0"><span>Selected text</span></p>',
    );
    const range = document.createRange();
    range.selectNodeContents(root);
    const rects = createRectsFromDOMRange({getRootElement: () => root}, range);

    expect(rects).toHaveLength(1);
    expect(rects[0].width).toBeLessThan(root.getBoundingClientRect().width);
    expectTextCovered(root, rects);
  });
});
