/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {expect, onTestFinished, test, vi} from 'vitest';

import {createDragAutoScroller} from '../../shared/dragAutoScroll';

function fixture(ownerDocument = document) {
  const container = ownerDocument.createElement('div');
  container.style.cssText =
    'position:fixed;top:60px;left:60px;width:300px;height:200px;overflow:auto;';
  const root = ownerDocument.createElement('div');
  root.style.height = '2000px';
  container.append(root);
  ownerDocument.body.append(container);
  onTestFinished(() => container.remove());
  return {container, root};
}

// Control time, but use actual browser layout and scroll offsets.
function frames(view: Window) {
  let callback: FrameRequestCallback | null = null;
  let time = 0;
  vi.spyOn(view, 'requestAnimationFrame').mockImplementation(next => {
    callback = next;
    return 1;
  });
  vi.spyOn(view, 'cancelAnimationFrame').mockImplementation(() => {
    callback = null;
  });
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  return (elapsed = 16) => {
    const next = callback;
    callback = null;
    time += elapsed;
    next?.(time);
  };
}

test('scrolls with a stationary pointer, reverses at the top, and stops in the center or on cleanup', () => {
  const {container, root} = fixture();
  const tick = frames(window);
  const onScroll = vi.fn();
  const controller = createDragAutoScroller(root, onScroll);
  onTestFinished(controller.stop);
  controller.update(100, 259);
  tick();
  tick();
  expect(container.scrollTop).toBeGreaterThan(0);
  expect(onScroll).toHaveBeenCalled();
  controller.update(100, 61);
  tick();
  tick();
  tick();
  expect(container.scrollTop).toBe(0);
  controller.update(100, 259);
  tick();
  const beforeCenter = container.scrollTop;
  controller.update(100, 160);
  tick();
  expect(container.scrollTop).toBe(beforeCenter);
  controller.update(100, 259);
  controller.stop();
  tick();
  expect(container.scrollTop).toBe(beforeCenter);
});

test('ignores pointers outside the scrollport and stops at the scroll limit', () => {
  const {container, root} = fixture();
  const tick = frames(window);
  const controller = createDragAutoScroller(root, () => {});
  onTestFinished(controller.stop);
  controller.update(500, 259);
  tick();
  expect(container.scrollTop).toBe(0);
  container.scrollTop = container.scrollHeight;
  const limit = container.scrollTop;
  controller.update(100, 259);
  tick();
  tick();
  expect(container.scrollTop).toBe(limit);
});

test('uses visible container edges and respects overscroll containment before chaining', () => {
  const {container, root} = fixture();
  const inner = document.createElement('div');
  inner.style.cssText = 'height:200px;overflow:auto;margin-top:100px;';
  const content = document.createElement('div');
  content.style.height = '2000px';
  inner.append(content);
  root.append(inner);
  const tick = frames(window);
  const controller = createDragAutoScroller(content, () => {});
  onTestFinished(controller.stop);
  // The inner container extends below the outer one, so its visible bottom is 260.
  controller.update(100, 259);
  tick();
  expect(inner.scrollTop).toBeGreaterThan(0);
  expect(container.scrollTop).toBe(0);
  inner.scrollTop = inner.scrollHeight;
  inner.style.overscrollBehaviorY = 'contain';
  tick();
  expect(container.scrollTop).toBe(0);
  inner.style.overscrollBehaviorY = 'auto';
  controller.update(100, 259);
  tick();
  expect(container.scrollTop).toBeGreaterThan(0);
  container.scrollTop = 0;
  inner.style.overscrollBehaviorY = 'contain';
  content.style.height = '100px';
  controller.update(100, 259);
  tick();
  expect(container.scrollTop).toBe(0);
});

test('crosses a shadow root to scroll its host container', () => {
  const {container, root} = fixture();
  root.style.height = '';
  const content = document.createElement('div');
  content.style.height = '2000px';
  root.attachShadow({mode: 'open'}).append(content);
  const tick = frames(window);
  const controller = createDragAutoScroller(content, () => {});
  onTestFinished(controller.stop);
  controller.update(100, 259);
  tick();
  expect(container.scrollTop).toBeGreaterThan(0);
});

test('scrolls the owning iframe viewport without scrolling the containing document', () => {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'width:500px;height:400px;';
  document.body.append(iframe);
  onTestFinished(() => iframe.remove());
  const ownerDocument = iframe.contentDocument!;
  const view = iframe.contentWindow!;
  const root = ownerDocument.createElement('div');
  root.style.height = '3000px';
  ownerDocument.body.append(root);
  const tick = frames(view);
  const controller = createDragAutoScroller(root, () => {});
  onTestFinished(controller.stop);
  const parentScroll = window.scrollY;
  controller.update(100, view.innerHeight - 1);
  tick();
  expect(view.scrollY).toBeGreaterThan(0);
  expect(window.scrollY).toBe(parentScroll);
  controller.update(100, 1);
  tick();
  tick();
  expect(view.scrollY).toBe(0);
});

test('scales speed with elapsed time and caps long frame gaps', () => {
  const {container, root} = fixture();
  const tick = frames(window);
  const controller = createDragAutoScroller(root, () => {});
  onTestFinished(controller.stop);
  controller.update(100, 259);
  tick();
  const first = container.scrollTop;
  tick(16);
  tick(16);
  const normal = container.scrollTop - first;
  controller.stop();
  container.scrollTop = 0;
  controller.update(100, 259);
  tick();
  const restart = container.scrollTop;
  for (let i = 0; i < 4; i++) {
    tick(8);
  }
  expect(Math.abs(container.scrollTop - restart - normal)).toBeLessThan(3);
  const beforeGap = container.scrollTop;
  tick(1000);
  expect(container.scrollTop - beforeGap).toBeLessThanOrEqual(35);
});

test('scrolls immediately even when CSS requests smooth scrolling', () => {
  const {container, root} = fixture();
  container.style.scrollBehavior = 'smooth';
  const tick = frames(window);
  const controller = createDragAutoScroller(root, () => {});
  onTestFinished(controller.stop);
  controller.update(100, 259);
  tick();
  expect(container.scrollTop).toBeGreaterThan(0);
});
