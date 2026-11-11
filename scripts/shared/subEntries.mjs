/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @ts-check

/**
 * The entries that publish sub-entries, by package: each
 * `src/<entry>/<name>.ts` of a listed entry is exported as
 * `<package>/<entry>/<name>` (see updateVersion). Opt-in: any other
 * directory under `src/` is internal, whatever it holds.
 *
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
export const SUB_ENTRIES = {
  // The frozen layout migration steps (@lexical/y/migrate/1to2, ...).
  '@lexical/y': ['migrate'],
};

/**
 * The entries of `packageName` that publish sub-entries.
 *
 * @param {string} packageName
 * @returns {ReadonlyArray<string>}
 */
export function subEntriesOf(packageName) {
  return SUB_ENTRIES[packageName] || [];
}
