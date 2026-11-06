/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Changelog functions in the shape `@changesets/cli` expects, so this
 * directory stays compatible with standard changesets tooling.
 *
 * Lexical's release does not use that tooling (it is not a dependency):
 * the release workflow picks the version and
 * `scripts/changesets/release.mjs` writes the root CHANGELOG.md from the
 * pending changesets. This module renders an entry the same way for any
 * tool that loads `.changeset/config.json`.
 */

'use strict';

/**
 * @param {{summary: string}} changeset
 * @returns {Promise<string>}
 */
async function getReleaseLine(changeset) {
  const {parseEntry, renderEntry} =
    await import('../scripts/changesets/entry.mjs');
  const entry = parseEntry(changeset.summary);
  return renderEntry({
    category: entry.category || 'chore',
    contributors: entry.contributors.map(handle => `@${handle}`),
    details: entry.details,
    packages: [],
    pr: null,
    summary: `[${entry.category || 'chore'}] ${entry.summary}`,
  });
}

/**
 * Every published package is in one `fixed` group and depends on its
 * siblings with `workspace:*`, so "updated dependencies" lines are noise.
 *
 * @returns {Promise<string>}
 */
async function getDependencyReleaseLine() {
  return '';
}

module.exports = {getDependencyReleaseLine, getReleaseLine};
