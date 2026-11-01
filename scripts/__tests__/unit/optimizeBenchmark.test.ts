/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {describe, expect, test} from 'vitest';

import {optimizeBenchmark} from '../../shared/optimizeBenchmark.mjs';

describe('optimizeBenchmark', () => {
  test('eliminates renamed false guards and their bodies', async () => {
    const result = await optimizeBenchmark(`
      var __DEV__ = false;
      var __DEV__2 = false;
      export function run() {
        if (__DEV__) throw new Error('first-dev-branch');
        if (__DEV__2) throw new Error('second-dev-branch');
        return 42;
      }
    `);
    expect(result.eliminatedDevConstants).toBe(2);
    expect(result.code).not.toContain('__DEV__');
    expect(result.code).not.toContain('dev-branch');
    expect(result.code).toContain('42');
  });

  test.each([
    'var __DEV__ = true; export function run() { return __DEV__; }',
    'export function run() { return __DEV__; }',
    'var __DEV__ = false; __DEV__ = true; export function run() { return __DEV__; }',
  ])(
    'rejects an unverified or mutable development constant: %s',
    async source => {
      await expect(optimizeBenchmark(source)).rejects.toThrow(
        'development constant',
      );
    },
  );
});
