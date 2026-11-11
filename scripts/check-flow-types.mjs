/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {spawn} from 'node:child_process';

/**
 * @param {unknown} [renderer] unused legacy argument
 * @param {readonly string[]} [args] arguments to pass to the flow binary
 * @returns {Promise<void>}
 */
async function runFlow(renderer, args) {
  return new Promise(resolve => {
    let cmd = import.meta.dirname + '/../node_modules/.bin/flow';
    if (process.platform === 'win32') {
      cmd = cmd.replace(/\//g, '\\') + '.cmd';
    }

    console.log('Running Flow...');

    // `spawn` has no overload for `(command, undefined, SpawnOptions)` even
    // though Node accepts `undefined` (treated as no args) at runtime, so the
    // optional `args` is narrowed to the array form expected by the overload.
    spawn(cmd, /** @type {readonly string[]} */ (args), {
      // Allow colors to pass through:
      stdio: 'inherit',
    }).on('close', function (/** @type {number | null} */ code) {
      if (code !== 0) {
        console.error('Flow failed :(');
        console.log();
        process.exit(code);
      } else {
        resolve();
      }
    });
  });
}

// Check the whole project in the foreground without requiring a background server.
runFlow(undefined, ['full-check']);
