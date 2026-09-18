/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * The on-screen scale of `element`'s own coordinate space, accumulated over
 * every CSS `transform` / `scale` between it and the viewport.
 *
 * `getBoundingClientRect()` reports on-screen pixels, but a `translate()`
 * written back to `style.transform` is applied in the element's own — still
 * unscaled — coordinate space. Any offset derived from client rects therefore
 * has to be divided by this scale first, and any constant expressed in the
 * element's own pixels has to be multiplied by it before being mixed into
 * client-rect arithmetic.
 *
 * Falls back to 1 for either axis that has no layout box to measure against.
 */
export function getElementScale(element: HTMLElement): {x: number; y: number} {
  const {height, width} = element.getBoundingClientRect();
  const {offsetHeight, offsetWidth} = element;
  const x = offsetWidth > 0 ? width / offsetWidth : 1;
  const y = offsetHeight > 0 ? height / offsetHeight : 1;
  return {
    x: Number.isFinite(x) && x > 0 ? x : 1,
    y: Number.isFinite(y) && y > 0 ? y : 1,
  };
}
