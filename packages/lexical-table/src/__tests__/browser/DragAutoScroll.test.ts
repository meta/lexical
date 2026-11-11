/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {$createTableNodeWithDimensions, TableExtension} from '@lexical/table';
import {$getRoot} from 'lexical';
import {assert, expect, onTestFinished, test, vi} from 'vitest';

// Drag auto-scroll (#7153) runs on animation frames. This test runs those
// frames itself, with the timestamps of a chosen frame rate, so it measures
// how far a table scrolls in a given time without depending on how fast the
// browser happens to render.

function mount() {
  const style = document.createElement('style');
  // Ten columns of at least 100px overflow the 300px wide editor.
  style.textContent = 'th, td { min-width: 100px; }';
  document.head.appendChild(style);
  const container = document.createElement('div');
  // Clear of the top of the viewport, which has an edge zone of its own.
  container.style.margin = '100px 0';
  container.style.width = '300px';
  document.body.appendChild(container);
  const root = document.createElement('div');
  root.contentEditable = 'true';
  container.appendChild(root);
  const editor = buildEditorFromExtensions({
    dependencies: [RichTextExtension, TableExtension],
    name: 'test/drag-auto-scroll',
    theme: {tableScrollableWrapper: ''},
  });
  editor.setRootElement(root);
  // Run by the caller and again when the test finishes: both steps can
  // repeat.
  const unmount = () => {
    editor.dispose();
    container.remove();
    style.remove();
  };
  onTestFinished(unmount);
  editor.update(
    () => {
      $getRoot()
        .clear()
        .append($createTableNodeWithDimensions(2, 10, false));
    },
    {discrete: true},
  );
  const table = root.querySelector('table');
  assert(table !== null, 'Expected the table to be rendered');
  const wrapper = table.parentElement;
  assert(wrapper !== null, 'Expected the table to have a scroll wrapper');
  expect(wrapper.scrollWidth).toBeGreaterThan(wrapper.clientWidth);
  return {table, unmount, wrapper};
}

/**
 * Takes over requestAnimationFrame until `restore` is called or the test
 * finishes. `runFrame` runs the callbacks requested so far as one frame at
 * `time`.
 */
function captureAnimationFrames() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  const requestSpy = vi
    .spyOn(window, 'requestAnimationFrame')
    .mockImplementation(callback => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    });
  const cancelSpy = vi
    .spyOn(window, 'cancelAnimationFrame')
    .mockImplementation(id => {
      callbacks.delete(id);
    });
  const restore = () => {
    requestSpy.mockRestore();
    cancelSpy.mockRestore();
  };
  onTestFinished(restore);
  return {
    restore,
    runFrame(time: number) {
      const frame = [...callbacks.values()];
      callbacks.clear();
      for (const callback of frame) {
        callback(time);
      }
    },
  };
}

/**
 * With the table's scroll wrapper scrolled as far from `edge` as it goes,
 * presses the mouse in the second row's cell at the other end and holds it
 * `inset` px inside `edge`, then runs frames at `frameMs` intervals for 100ms.
 * Returns how far the wrapper scrolled.
 */
function autoScrollFor100ms(
  frameMs: number,
  edge: 'left' | 'right' = 'right',
  inset = 5,
): number {
  const {table, unmount, wrapper} = mount();
  if (edge === 'left') {
    wrapper.scrollLeft = wrapper.scrollWidth;
  }
  const startScrollLeft = wrapper.scrollLeft;
  const cell = table
    .querySelectorAll('tr')[1]
    .querySelector(edge === 'left' ? 'td:last-child' : 'td');
  assert(cell !== null, 'Expected the second row to have a cell');
  const cellRect = cell.getBoundingClientRect();
  const clientY = cellRect.top + cellRect.height / 2;
  const pointer = (type: string, clientX: number) =>
    cell.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX,
        clientY,
        pointerId: 1,
        pointerType: 'mouse',
      }),
    );
  const wrapperRect = wrapper.getBoundingClientRect();
  const holdX =
    edge === 'left' ? wrapperRect.left + inset : wrapperRect.right - inset;
  const {restore, runFrame} = captureAnimationFrames();
  pointer('pointerdown', cellRect.left + cellRect.width / 2);
  pointer('pointermove', holdX);
  const frames = Math.round(100 / frameMs);
  for (let frame = 0; frame <= frames; frame++) {
    runFrame(1000 + frame * frameMs);
  }
  pointer('pointerup', holdX);
  const distance = Math.abs(wrapper.scrollLeft - startScrollLeft);
  // Before the next measurement, which mounts another editor. Both run again
  // when the test finishes, which also covers a measurement that throws.
  restore();
  unmount();
  return distance;
}

test('drag auto-scroll covers the same distance in the same time at any frame rate', () => {
  const at60Hz = autoScrollFor100ms(1000 / 60);
  const at10Hz = autoScrollFor100ms(100);
  expect(at60Hz).toBeGreaterThan(0);
  expect(at10Hz).toBe(at60Hz);
});

test('drag auto-scroll covers the same distance toward either edge', () => {
  // 5.5px into an edge zone scrolls 3px a frame, which a 25ms frame scales
  // to 4.5px.
  const toRight = autoScrollFor100ms(25, 'right', 34.5);
  const toLeft = autoScrollFor100ms(25, 'left', 34.5);
  expect(toRight).toBeGreaterThan(0);
  expect(toLeft).toBe(toRight);
});
