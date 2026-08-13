/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Tests iOS and iPadOS detection, including iPadOS environments that expose
 * a desktop-class Macintosh user agent.
 *
 * environment.ts computes its exports at module load time, so each test
 * overrides navigator values, resets the module registry, and re-imports the
 * module.
 */

import {afterEach, describe, expect, test, vi} from 'vitest';

const IPHONE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 ' +
  'Mobile/15E148 Safari/604.1';

const IPAD_USER_AGENT =
  'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 ' +
  'Mobile/15E148 Safari/604.1';

const MACINTOSH_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 ' +
  'Safari/605.1.15';

const WINDOWS_TOUCH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 ' +
  'Safari/537.36';

function setNavigator(userAgent: string, maxTouchPoints: number): void {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    get: () => userAgent,
  });
  Object.defineProperty(navigator, 'maxTouchPoints', {
    configurable: true,
    get: () => maxTouchPoints,
  });
}

// Remove the own properties installed by setNavigator so lookups fall back
// to the navigator prototype or other values provided by the test environment.
function resetNavigator(): void {
  Reflect.deleteProperty(navigator, 'userAgent');
  Reflect.deleteProperty(navigator, 'maxTouchPoints');
}

async function getIsIOS(
  userAgent: string,
  maxTouchPoints: number,
): Promise<boolean> {
  setNavigator(userAgent, maxTouchPoints);
  vi.resetModules();

  const {IS_IOS} = await import('../../environment');

  return IS_IOS;
}

afterEach(() => {
  resetNavigator();
  vi.resetModules();
});

describe('IS_IOS', () => {
  test.each([
    {
      expected: true,
      maxTouchPoints: 5,
      name: 'iPhone user agent',
      userAgent: IPHONE_USER_AGENT,
    },
    {
      expected: true,
      maxTouchPoints: 5,
      name: 'iPad user agent',
      userAgent: IPAD_USER_AGENT,
    },
    {
      expected: true,
      maxTouchPoints: 5,
      name: 'iPadOS desktop-class Macintosh user agent with multi-touch',
      userAgent: MACINTOSH_USER_AGENT,
    },
    {
      expected: true,
      maxTouchPoints: 2,
      name: 'Macintosh user agent at the multi-touch boundary',
      userAgent: MACINTOSH_USER_AGENT,
    },
    {
      expected: false,
      maxTouchPoints: 1,
      name: 'Macintosh user agent without multi-touch',
      userAgent: MACINTOSH_USER_AGENT,
    },
    {
      expected: false,
      maxTouchPoints: 0,
      name: 'macOS user agent without touch support',
      userAgent: MACINTOSH_USER_AGENT,
    },
    {
      expected: false,
      maxTouchPoints: 10,
      name: 'non-Apple touch device',
      userAgent: WINDOWS_TOUCH_USER_AGENT,
    },
  ])(
    'returns $expected for $name',
    async ({expected, maxTouchPoints, userAgent}) => {
      await expect(getIsIOS(userAgent, maxTouchPoints)).resolves.toBe(expected);
    },
  );
});
