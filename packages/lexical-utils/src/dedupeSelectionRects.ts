/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

export type RectLike = Pick<
  DOMRect,
  'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'
>;

/**
 * Dedupe a list of selection client-rects before they are drawn as fills.
 *
 * `Range.getClientRects()` can return rects that are duplicated or contained
 * within another, and WebKit in particular emits a spurious wider rect alongside
 * the real text rect on some blocks (balanced or letter-spaced headings are the
 * reproducible case). Drawn as semi-transparent fills, duplicates read brighter
 * than a single rect, and the wider rect paints the "extra empty selection area"
 * reported in meta/lexical#7106.
 *
 * This drops zero-area rects and any rect that contains another, keeping the
 * smaller text-hugging one, with a 1px tolerance for sub-pixel jitter. The
 * assumption is that genuine same-line rects are horizontally disjoint (one rect
 * per visual row; inline boxes on a row tile side by side), so containment only
 * holds for the duplicate or spurious-wider cases, never for a legitimate
 * sub-fragment that should be kept.
 *
 * `positionNodeOnRange` uses a coverage-preserving duplicate filter instead:
 * `createRectsFromDOMRange` already drops full-block-width spurious rects, and
 * keeping only the smaller of two different overlapping rects can erase real
 * selected text there. Raw `getClientRects()` consumers still use this helper
 * to avoid the #7106 extra-area paint.
 *
 * Known limitation: the disjoint assumption holds for normal flow. Overlapping
 * inline content — a negative margin, a transform, or a baseline-shifted inline
 * decorator — can place a real sub-fragment inside a wider real-text rect on the
 * same row; if a sub-pixel top offset also keeps the smaller rect from being
 * strictly contained in the wider one, both survive `createRectsFromDOMRange`'s
 * containment filter, and applying this keep-smaller helper afterward drops the
 * wider rect and under-paints the glyphs it uniquely covered. There is no
 * rect-only fix: that wider rect is geometrically indistinguishable from the
 * spurious-wider (#7106) rect, so keeping it would re-introduce the extra-area
 * paint. See the under-paint characterization browser test.
 *
 * Typed on the structural subset of `DOMRect` it reads, so it accepts a live
 * `DOMRectList` from `getClientRects()` as well as the `DOMRect[]` returned by
 * `createRectsFromDOMRange`, and is unit-testable without a DOM.
 */
export default function dedupeSelectionRects<Rect extends RectLike>(
  rects: Iterable<Rect>,
): Rect[] {
  const contains = (a: RectLike, b: RectLike): boolean =>
    b.left >= a.left - 1 &&
    b.top >= a.top - 1 &&
    b.right <= a.right + 1 &&
    b.bottom <= a.bottom + 1;
  const kept: Rect[] = [];
  for (const rect of Array.from(rects)) {
    if (rect.width < 0.5 || rect.height < 0.5) {
      continue;
    }
    // `rect` contains a smaller rect already kept: keep the smaller one.
    if (kept.some(keptRect => contains(rect, keptRect))) {
      continue;
    }
    // A kept rect contains `rect`: drop the larger, keep the smaller `rect`.
    for (let i = kept.length - 1; i >= 0; i--) {
      if (contains(kept[i], rect)) {
        kept.splice(i, 1);
      }
    }
    kept.push(rect);
  }
  return kept;
}
