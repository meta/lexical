/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {describe, expect, onTestFinished, test} from 'vitest';

import {setFloatingElemPosition} from '../../utils/setFloatingElemPosition';

const VERTICAL_GAP = 10;
const HORIZONTAL_OFFSET = 5;

// Where the floating element should end up, in on-screen pixels: the CSS gaps
// are authored in the scaled coordinate space, so they shrink with the scale.
function build(scale: number) {
  const outer = document.createElement('div');
  outer.style.transform = `scale(${scale})`;
  outer.style.transformOrigin = '0 0';
  outer.style.width = '800px';

  const scroller = document.createElement('div');
  scroller.style.position = 'relative';
  scroller.style.width = '800px';
  scroller.style.height = '600px';

  const anchor = document.createElement('div');
  anchor.style.position = 'relative';
  anchor.style.width = '800px';
  anchor.style.height = '600px';

  const floating = document.createElement('div');
  floating.style.position = 'absolute';
  floating.style.top = '0';
  floating.style.left = '0';
  floating.style.width = '200px';
  floating.style.height = '40px';

  const target = document.createElement('div');
  target.style.position = 'absolute';
  target.style.top = '300px';
  target.style.left = '120px';
  target.style.width = '90px';
  target.style.height = '20px';

  anchor.append(floating, target);
  scroller.append(anchor);
  outer.append(scroller);
  document.body.append(outer);
  onTestFinished(() => outer.remove());

  // The helpers inspect the DOM selection to detect end-aligned text; keep it
  // empty so that branch stays out of the way.
  window.getSelection()?.removeAllRanges();

  return {anchor, floating, scroller, target};
}

function measure(scale: number) {
  const {anchor, floating, target} = build(scale);
  return {
    anchor,
    floating,
    // The accumulated on-screen scale of the anchor's coordinate space.
    realScale: anchor.getBoundingClientRect().width / anchor.offsetWidth,
    target,
    targetRect: target.getBoundingClientRect(),
  };
}

describe('floating element positioning under CSS scale (#6748)', () => {
  for (const scale of [1, 0.5, 2]) {
    // scale 1 is the control: it must keep behaving exactly as before.
    test(`setFloatingElemPosition places the toolbar above the target at scale ${scale}`, () => {
      const {anchor, floating, targetRect, realScale} = measure(scale);
      expect(realScale).toBeCloseTo(scale, 5);

      setFloatingElemPosition(targetRect, floating, anchor);

      const rect = floating.getBoundingClientRect();
      expect(rect.bottom).toBeCloseTo(
        targetRect.top - VERTICAL_GAP * realScale,
        1,
      );
      expect(rect.left).toBeCloseTo(
        targetRect.left - HORIZONTAL_OFFSET * realScale,
        1,
      );
    });
  }
});
