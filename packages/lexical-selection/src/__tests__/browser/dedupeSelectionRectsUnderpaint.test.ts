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

/**
 * Characterizes the documented KNOWN LIMITATION of dedupeSelectionRects' keep-smaller
 * rule (see its docstring): for OVERLAPPING inline content it can drop a wider rect
 * that covers real selected area, under-painting the part it uniquely covered.
 *
 * Uses real browser layout (Chromium / Firefox / WebKit) and the real
 * createRectsFromDOMRange + dedupeSelectionRects. The construction uses
 * explicit-width inline boxes and a fixed sub-pixel transform so the geometry is
 * identical across platforms (no dependence on font glyph metrics), and the
 * assertions are structural (no hard-coded pixel thresholds): the root is a real,
 * laid-out element so getBoundingClientRect / getComputedStyle are real; only
 * `editor` is a getRootElement shim, which is all the helper reads off it.
 */

const ROOT_WIDTH = 600;

function setupRoot(): HTMLDivElement {
  const root = document.createElement('div');
  root.style.position = 'absolute';
  root.style.left = '0px';
  root.style.top = '0px';
  root.style.width = `${ROOT_WIDTH}px`;
  root.style.padding = '0px';
  root.style.margin = '0px';
  root.style.font = '16px/1 monospace';
  document.body.style.margin = '0px';
  document.body.appendChild(root);
  return root;
}

// Containment predicate matching dedupeSelectionRects (1px tolerance).
function contains(a: DOMRect, b: DOMRect): boolean {
  return (
    b.left >= a.left - 1 &&
    b.top >= a.top - 1 &&
    b.right <= a.right + 1 &&
    b.bottom <= a.bottom + 1
  );
}

const sameRect = (a: DOMRect, b: DOMRect): boolean =>
  Math.abs(a.left - b.left) < 1 &&
  Math.abs(a.right - b.right) < 1 &&
  Math.abs(a.top - b.top) < 1 &&
  Math.abs(a.bottom - b.bottom) < 1;

function selectAll(root: HTMLElement): Range {
  const r = document.createRange();
  r.selectNodeContents(root);
  return r;
}

describe('dedupeSelectionRects under-paints real content for overlapping inline boxes', () => {
  it('drops the wider rect that uniquely covers part of the selection', () => {
    const root = setupRoot();
    onTestFinished(() => root.remove());

    // A wide run of text, then an inline box pulled back over it with a negative
    // margin so it overlaps the run, and raised 0.5px (vertical-align) so its top
    // sits a hair above the text run's. The selection's client rects follow the
    // glyphs, so the text run is a genuinely wide rect; the raise means the box
    // is not strictly contained in the text rect, so createRectsFromDOMRange's
    // containment filter keeps both. The wide text rect AND the box rect survive;
    // keep-smaller then drops the wide one. (The box stands in for any overlapping
    // inline content, e.g. a baseline-shifted inline decorator.) Assertions are
    // structural — no pixel thresholds — so they hold whatever the monospace glyph
    // width is.
    root.innerHTML =
      `<p style="margin:0">aaaaaaaaaaaaaaaa` +
      `<span style="display:inline-block;width:12px;height:18px;margin-left:-100px;vertical-align:0.5px;background:rgba(255,0,0,.4)">N</span>` +
      `</p>`;
    void root.offsetHeight;

    const range = selectAll(root);
    const survivors = createRectsFromDOMRange(
      {getRootElement: () => root},
      range,
    );

    // createRectsFromDOMRange leaves a same-row contained pair: a wider rect that
    // strictly contains a narrower survivor.
    let wide: DOMRect | undefined;
    let narrow: DOMRect | undefined;
    for (const a of survivors) {
      for (const b of survivors) {
        if (
          a !== b &&
          contains(a, b) &&
          a.width > b.width + 2 &&
          !contains(b, a)
        ) {
          wide = a;
          narrow = b;
        }
      }
    }
    expect(
      wide && narrow,
      'createRectsFromDOMRange left a same-row contained pair (wider ⊇ narrower)',
    ).toBeTruthy();
    if (!wide || !narrow) return;

    // dedupeSelectionRects drops the wider rect (keep-smaller)...
    const deduped = dedupeSelectionRects(survivors);
    expect(
      deduped.some(r => sameRect(r, wide)),
      'the wider rect was dropped by keep-smaller dedupe',
    ).toBe(false);

    // ...and nothing left covers the wide rect's left edge, so the area it uniquely
    // covered (left of the pulled-back box) goes unpainted — the under-paint.
    const probeX = wide.left + 1;
    const probeY = wide.top + wide.height / 2;
    const covered = deduped.some(
      r =>
        r.left <= probeX &&
        r.right >= probeX &&
        r.top <= probeY &&
        r.bottom >= probeY,
    );
    expect(
      covered,
      'the wide rect left edge is left unpainted after dedupe',
    ).toBe(false);
  });
});
