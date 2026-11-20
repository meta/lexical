/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {describe, expect, it} from 'vitest';

import {
  CONTENT_SCRIPT_PING,
  isContentScriptPing,
} from '../../contentScriptPing';

describe('isContentScriptPing', () => {
  it('accepts the ping message', () => {
    expect(isContentScriptPing({type: CONTENT_SCRIPT_PING})).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isContentScriptPing(undefined)).toBe(false);
    expect(isContentScriptPing(null)).toBe(false);
    expect(isContentScriptPing(CONTENT_SCRIPT_PING)).toBe(false);
    expect(isContentScriptPing({type: 'other'})).toBe(false);
    expect(isContentScriptPing({})).toBe(false);
  });
});
