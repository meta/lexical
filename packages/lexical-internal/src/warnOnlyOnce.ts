/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

const __DEV__ = process.env.NODE_ENV !== 'production';

/**
 * Returns a function that logs `message` with `console.warn` the first time it
 * is called (and never in production). Creating one has no effect, so the
 * build annotates module-scope calls and a bundler can drop an unused warning.
 *
 * @__NO_SIDE_EFFECTS__
 */
/*@__INLINE__*/
export default function warnOnlyOnce(message: string): () => void {
  if (__DEV__) {
    let run = false;
    return () => {
      if (!run) {
        console.warn(message);
      }
      run = true;
    };
  } else {
    return () => {};
  }
}
