/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * The smallest power of two of arguments a spread into a call throws on in
 * this runtime (Node's main thread: 131,072; a worker thread: 524,288).
 */
function argumentLimit(): number {
  for (let n = 1 << 16; n <= 1 << 24; n *= 2) {
    const items = new Array<string>(n).fill('x');
    try {
      [].push(...(items as never[]));
    } catch {
      return n;
    }
  }
  throw new Error('no argument limit up to 2^24');
}

export const LIMIT = argumentLimit();
/** Lines whose nodes (a text and a line break per line) pass the limit. */
export const LINES = Math.ceil(LIMIT / 2) + 2_048;
