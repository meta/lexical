/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// The boundary matrix (see utils/boundaryMatrix) on desktop Safari, set before
// Lexical reads the browser.

import {IS_APPLE_WEBKIT, IS_IOS, IS_SAFARI} from 'lexical';
import {expect, test, vi} from 'vitest';

import {runBoundaryMatrix} from '../utils/boundaryMatrix';

vi.hoisted(() => {
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    value:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  });
  Object.defineProperty(window.navigator, 'platform', {
    configurable: true,
    value: 'MacIntel',
  });
  Object.defineProperty(window.navigator, 'maxTouchPoints', {
    configurable: true,
    value: 0,
  });
});

test('the browser is desktop Safari', () => {
  expect([IS_SAFARI, IS_APPLE_WEBKIT, IS_IOS]).toEqual([true, true, false]);
});

runBoundaryMatrix('desktop Safari');
