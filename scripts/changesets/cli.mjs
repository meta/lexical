/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Shared command-line helpers for the changeset scripts.
 */

import {parseArgs} from 'node:util';

/**
 * Exit quietly when stdout is closed early (`... | head`).
 */
export function exitOnEpipe() {
  process.stdout.on('error', error => {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EPIPE') {
      process.exit(0);
    }
    throw error;
  });
}

/**
 * Strict `parseArgs`: unknown options and positionals are errors. A bare
 * `--` (from `pnpm run x -- --flag`) is ignored.
 *
 * @template {import('node:util').ParseArgsConfig['options']} T
 * @param {string[]} argv
 * @param {T} options
 * @returns {{values: any} | {error: string}}
 */
export function parseStrict(argv, options) {
  try {
    const {values} = parseArgs({
      allowPositionals: false,
      args: argv.filter(arg => arg !== '--'),
      options,
      strict: true,
    });
    return {values};
  } catch (error) {
    return {error: /** @type {Error} */ (error).message};
  }
}
