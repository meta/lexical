/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Custom commands for the browser test project. They run in the Vitest
// process with the Playwright provider's page, and tests call them through
// `commands` from 'vitest/browser', whose types are derived from these in
// packages/lexical/src/__tests__/browser/utils/vitest.d.ts.

import type {} from '@vitest/browser-playwright';
import type {BrowserCommandContext} from 'vitest/node';

import {strict as assert} from 'node:assert';

type Point = [x: number, y: number];

/**
 * Drive a real mouse drag through `points` (relative to the top-left of
 * `selector`'s border box), so the browser's own hit testing and
 * drag-extension logic decide the selection. Synthetic
 * Selection.setBaseAndExtent/extend calls do not model that. The mouse moves
 * between the points in steps of at most `maxStep` pixels, after a first
 * move of a pixel or two, or, with `quickStart`, from the press at once, as a
 * hand that moves fast does, before the browser has handled the press. With
 * `hold`, the pointer stays still for that many milliseconds after the
 * press, which macOS Chromium and WebKit wait for (150ms) before a press on
 * a selection can drag it rather than select from the pointer. A clickCount
 * above 1 makes the press that drags the last click of a double or triple
 * click. The `modifiers` keys are held from before the first press until the
 * release.
 */
async function mouseDrag(
  {context, frame, page}: BrowserCommandContext,
  selector: string,
  points: [first: Point, ...rest: Point[]],
  {
    clickCount = 1,
    hold = 0,
    maxStep = Infinity,
    modifiers = [],
    quickStart = false,
  }: {
    clickCount?: number;
    hold?: number;
    maxStep?: number;
    modifiers?: ('Alt' | 'Control' | 'Meta' | 'Shift')[];
    quickStart?: boolean;
  } = {},
): Promise<void> {
  const target = (await frame()).locator(selector);
  const [first, ...rest] = points;
  // A person's mouse events arrive far enough apart that the browser and the
  // editor have handled each one, and the selection changes it caused,
  // before the next. Count the pointer events of the drag that the frame has
  // dispatched, and remember the selection each selectionchange reported, so
  // that each step can wait for exactly that instead of for a while. The
  // element stays put during a drag, so scroll it into view here too, without
  // scrollIntoViewIfNeeded, which waits for it to stay put for two frames.
  const tracker = await target.evaluateHandle(element => {
    element.scrollIntoView({block: 'nearest', inline: 'nearest'});
    const getPoints = () => {
      const selection = document.getSelection();
      return selection === null
        ? []
        : [
            selection.anchorNode,
            selection.anchorOffset,
            selection.focusNode,
            selection.focusOffset,
          ];
    };
    const controller = new AbortController();
    const listenerOptions = {capture: true, signal: controller.signal};
    const state = {
      dispose: () => controller.abort(),
      events: 0,
      getPoints,
      notified: getPoints(),
    };
    const count = () => {
      state.events++;
    };
    window.addEventListener('pointerdown', count, listenerOptions);
    window.addEventListener('pointerup', count, listenerOptions);
    // Not the move to the first point, before the press.
    window.addEventListener(
      'pointermove',
      event => event.buttons !== 0 && count(),
      listenerOptions,
    );
    window.addEventListener(
      'selectionchange',
      () => {
        state.notified = getPoints();
      },
      listenerOptions,
    );
    return state;
  });
  // Move the mouse to page coordinates from the element's box.
  const box = await target.boundingBox();
  assert(box !== null, `mouseDrag target ${selector} is not visible`);
  await page.mouse.move(box.x + first[0], box.y + first[1]);
  let events = 0;
  const browser = context.browser();
  const isWebKit =
    browser !== null && browser.browserType().name() === 'webkit';
  // Wait until the frame has dispatched the step's pointer event, then until
  // the tasks it queued have run and no selectionchange is still to be
  // dispatched and handled.
  const settle = async (name: string) => {
    const result = await tracker.evaluate(
      async (state, [expected, webKit]) => {
        const nextTask = () =>
          new Promise<void>(resolve => setTimeout(resolve, 0));
        const isSame = (a: unknown[], b: unknown[]) =>
          a.every((value, i) => value === b[i]);
        // Never hang a test on an event the browser coalesced or a selection
        // that keeps changing.
        const deadline = performance.now() + 1000;
        let isSettled = false;
        let current = state.getPoints();
        let unchangedTasks = 0;
        do {
          await nextTask();
          const next = state.getPoints();
          // Counted from the step's event, which can come after the wait starts.
          unchangedTasks =
            state.events >= expected && isSame(next, current)
              ? unchangedTasks + 1
              : 0;
          current = next;
          // WebKit reports no selectionchange for a selection that it takes for
          // the one it has, such as points on either side of a user-select:none
          // box or of an inline element's edge, though the points change. So
          // there, points that a few tasks leave alone have settled too. The
          // other engines report every change.
          isSettled =
            state.events >= expected &&
            (isSame(current, state.notified) ||
              (webKit && unchangedTasks >= 3));
        } while (!isSettled && performance.now() < deadline);
        return {events: state.events, isSettled};
      },
      [events + 1, isWebKit] as const,
    );
    // Count from what the frame saw, so that a step that dispatched more
    // than one pointer event doesn't let later steps stop waiting early.
    events = result.events;
    if (!result.isSettled) {
      console.warn(`mouseDrag ${selector}: ${name} did not settle in 1s`);
    }
  };
  // Take a step and settle it, waiting from the start of the step so that the
  // wait costs no round trip of its own.
  const step = async (name: string, action: Promise<void>) => {
    await Promise.all([action, settle(name)]);
  };
  let isPressed = false;
  const heldKeys: string[] = [];
  try {
    for (const key of modifiers) {
      await page.keyboard.down(key);
      heldKeys.push(key);
    }
    for (let count = 1; count < clickCount; count++) {
      await step(`press ${count}`, page.mouse.down({clickCount: count}));
      await step(`release ${count}`, page.mouse.up({clickCount: count}));
    }
    const press = page.mouse.down({clickCount});
    isPressed = true;
    let [lastX, lastY] = first;
    if (quickStart) {
      await press;
      // The next step waits for the press's pointerdown too.
      events++;
    } else {
      await step('press', press);
      if (hold > 0) {
        await new Promise(resolve => setTimeout(resolve, hold));
      }
      // Chromium collapses the selection at the pointer on the first drag
      // move after a press that placed a caret, and extends it from there, so
      // a drag's anchor is where it first moved. A hand starts a drag with a
      // move of a pixel or two, so make the first move one.
      if (rest.length > 0) {
        const [x, y] = rest[0];
        const distance = Math.hypot(x - lastX, y - lastY);
        if (distance > 2) {
          lastX += ((x - lastX) * 2) / distance;
          lastY += ((y - lastY) * 2) / distance;
          await step(
            'first move',
            page.mouse.move(box.x + lastX, box.y + lastY),
          );
        }
      }
    }
    for (const [x, y] of rest) {
      const steps = Math.max(
        1,
        Math.ceil(Math.hypot(x - lastX, y - lastY) / maxStep),
      );
      for (let i = 1; i <= steps; i++) {
        await step(
          `move to (${x}, ${y})`,
          page.mouse.move(
            box.x + lastX + ((x - lastX) * i) / steps,
            box.y + lastY + ((y - lastY) * i) / steps,
          ),
        );
      }
      [lastX, lastY] = [x, y];
    }
    await step('release', page.mouse.up({clickCount}));
    isPressed = false;
  } finally {
    // Leave no button, key or listener behind for the next test, without
    // hiding the error that got here behind one from a frame that is gone.
    const ignore = () => {};
    if (isPressed) {
      await page.mouse.up({clickCount}).catch(ignore);
    }
    for (const key of heldKeys.reverse()) {
      await page.keyboard.up(key).catch(ignore);
    }
    await tracker.evaluate(state => state.dispose()).catch(ignore);
    await tracker.dispose().catch(ignore);
  }
}

/**
 * Vitest's keyboard descriptor parser splits non-BMP text into UTF-16 code
 * units. Native Playwright typing preserves code points, matching the E2E
 * driver's input behavior. Bound each code point so long input can make
 * progress on a busy runner, and stop if the fixture is removed. Keep the
 * loop in one command to avoid a Vitest RPC round trip for every character.
 */
async function typeText(
  {frame}: BrowserCommandContext,
  text: string,
  selector: string,
): Promise<void> {
  // Capture the element once: type() fails immediately if it detaches,
  // instead of resolving another fixture's editor.
  const target = await (await frame())
    .locator(selector)
    .elementHandle({timeout: 5000});
  assert(target !== null, 'typeText target was removed');
  try {
    for (const character of text) {
      await target.type(character, {timeout: 5000});
    }
  } finally {
    await target.dispose();
  }
}

export const browserCommands = {mouseDrag, typeText};
