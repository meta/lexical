/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalEditor} from 'lexical';

import {createRectsFromDOMRange} from '@lexical/selection';
import {dedupeSelectionRects} from '@lexical/utils';
import {describe, expect, it} from 'vitest';

function rect(left: number, top: number, width: number, height: number) {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
  };
}

describe('dedupeSelectionRects', () => {
  it('keeps one of two identical rects (the doubled-opacity duplicate)', () => {
    const kept = dedupeSelectionRects([
      rect(128, 166, 394, 18),
      rect(128, 166, 394, 18),
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0].width).toBe(394);
  });

  it('keeps the smaller text rect when a wider rect contains it (#7106 extra area)', () => {
    const text = rect(128, 90, 368, 40);
    const wider = rect(128, 90, 1024, 40);
    const kept = dedupeSelectionRects([text, wider]);
    expect(kept).toHaveLength(1);
    expect(kept[0].width).toBe(368);
  });

  it('keeps the smaller rect regardless of input order', () => {
    const text = rect(128, 90, 368, 40);
    const wider = rect(128, 90, 1024, 40);
    expect(dedupeSelectionRects([wider, text])[0].width).toBe(368);
    expect(dedupeSelectionRects([text, wider])[0].width).toBe(368);
  });

  it('preserves genuine multi-line rects (different rows are not contained)', () => {
    const row1 = rect(128, 90, 368, 18);
    const row2 = rect(128, 112, 200, 18);
    const kept = dedupeSelectionRects([row1, row1, row2, row2]);
    expect(kept).toHaveLength(2);
    expect(kept.map(r => r.top).sort((a, b) => a - b)).toEqual([90, 112]);
  });

  it('drops zero-area rects', () => {
    const kept = dedupeSelectionRects([
      rect(0, 0, 0, 18),
      rect(0, 0, 100, 0),
      rect(0, 0, 100, 18),
    ]);
    expect(kept).toHaveLength(1);
  });

  it('returns empty for an empty list', () => {
    expect(dedupeSelectionRects([])).toHaveLength(0);
  });

  it('treats near-identical rects within 1px as duplicates', () => {
    const kept = dedupeSelectionRects([
      rect(128, 166, 394, 18),
      {
        bottom: 184.5,
        height: 18.2,
        left: 128.4,
        right: 522.1,
        top: 166.3,
        width: 393.7,
      },
    ]);
    expect(kept).toHaveLength(1);
  });

  it('keeps horizontally disjoint rects on the same row (no false containment)', () => {
    // Two inline boxes tiled on one line: neither contains the other.
    const kept = dedupeSelectionRects([
      rect(0, 0, 50, 18),
      rect(100, 0, 50, 18),
    ]);
    expect(kept).toHaveLength(2);
  });

  it('does not clip a wide rect (e.g. trailing whitespace) against a disjoint narrower row', () => {
    // A wide first row plus a narrower second row: different rows, neither contained.
    const wideRow = rect(0, 0, 300, 18);
    const narrowRow = rect(0, 22, 80, 18);
    const kept = dedupeSelectionRects([wideRow, narrowRow]);
    expect(kept).toHaveLength(2);
    expect(kept.map(r => r.width).sort((a, b) => a - b)).toEqual([80, 300]);
  });

  it('keeps every row of a ragged multi-row selection (varying offsets, e.g. RTL)', () => {
    const rows = [
      rect(200, 0, 100, 18),
      rect(150, 22, 150, 18),
      rect(180, 44, 120, 18),
    ];
    expect(dedupeSelectionRects(rows)).toHaveLength(3);
  });
});

// Characterize why positionNodeOnRange must not compose this keep-smaller
// helper with createRectsFromDOMRange.
// createRectsFromDOMRange already runs its own dedupe — single-pass and
// adjacent-only: it sorts by top (3px tolerance) then left, drops a rect only when
// it is contained in the immediately-preceding KEPT rect, and drops rects spanning the
// full editor width. So the common #7106 block-width spurious rect is removed
// before dedupe; what can still reach dedupe is a same-row CONTAINED pair whose
// inner rect carries a sub-pixel-smaller top (as overlapping inline content
// produces), which the strict containment filter lets through. These tests run the REAL
// createRectsFromDOMRange against a faked root + range to characterize that.
type Rect = ReturnType<typeof rect>;

function fakeEditorWithRoot(rootWidth: number): LexicalEditor {
  const root = document.createElement('div');
  root.style.paddingLeft = '0px';
  root.style.paddingRight = '0px';
  root.getBoundingClientRect = () => ({width: rootWidth}) as DOMRect;
  return {getRootElement: () => root} as unknown as LexicalEditor;
}

function createRects(editor: LexicalEditor, rects: Rect[]): Rect[] {
  // .slice() so createRectsFromDOMRange's in-place sort/splice cannot mutate input.
  const range = {getClientRects: () => rects.slice()} as unknown as Range;
  return createRectsFromDOMRange(editor, range) as unknown as Rect[];
}

const widths = (rects: Rect[]): number[] =>
  rects.map(r => r.width).sort((a, b) => a - b);

describe('dedupeSelectionRects + createRectsFromDOMRange', () => {
  // A narrower text rect and a wider rect on the same visual row, the wider carrying
  // a sub-pixel-smaller top (wider.top 90.0 vs text.top 90.5) — the split overlapping
  // inline content produces. They group within createRectsFromDOMRange's 3px row
  // tolerance, but neither strictly contains the other: the text rect has a lower
  // bottom as well as a lower top. Both reach dedupe, which tolerates that sub-pixel
  // difference. (The full-block-width
  // #7106 rect would instead be dropped upstream by selectionSpansElement.)
  const text = (): Rect => rect(128, 90.5, 368, 18);
  const wider = (): Rect => rect(128, 90.0, 900, 18); // ≠ editor width (1200): not dropped as full-width

  it('createRectsFromDOMRange leaves the contained pair (its adjacent-only pass does not catch it)', () => {
    const editor = fakeEditorWithRoot(1200);
    expect(widths(createRects(editor, [text(), wider()]))).toEqual([368, 900]);
  });

  it('dedupeSelectionRects collapses that survivor pair to the text-hugging rect', () => {
    const editor = fakeEditorWithRoot(1200);
    expect(
      widths(dedupeSelectionRects(createRects(editor, [text(), wider()]))),
    ).toEqual([368]);
  });

  it('preserves the partially overlapping pair in either order before tolerant deduplication', () => {
    const editor = fakeEditorWithRoot(1200);
    // Neither rect is strictly contained, regardless of input order.
    expect(widths(createRects(editor, [text(), wider()]))).toEqual([368, 900]);
    expect(widths(createRects(editor, [wider(), text()]))).toEqual([368, 900]);
    // dedupeSelectionRects always keeps the smaller → same result either way.
    expect(widths(dedupeSelectionRects([text(), wider()]))).toEqual([368]);
    expect(widths(dedupeSelectionRects([wider(), text()]))).toEqual([368]);
  });

  it('keeps the smaller (text) rect by design — keeping the wider one re-introduces the #7106 extra-area paint', () => {
    // The pair is geometrically ambiguous: a spurious wide rect containing the real
    // text rect is indistinguishable from a (hypothetical) real wide rect containing
    // a redundant sub-fragment. A single dedupe must pick one; keeping the smaller
    // resolves toward the reproduced bug (#7106) — never the wider rect.
    const editor = fakeEditorWithRoot(1200);
    const kept = dedupeSelectionRects(createRects(editor, [text(), wider()]));
    expect(kept).toHaveLength(1);
    expect(kept[0].width).toBe(368);
  });
});
