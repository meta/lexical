#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * `pnpm run changelog:range -- --from 0.40.0 [--to 0.52.0] [--breaking] [--json]`
 *
 * Print every CHANGELOG.md entry newer than --from and no newer than --to
 * (default: the newest version in the file), oldest first, which is the
 * order to apply migrations in.
 *
 *   --breaking   only breaking changes, behavior changes and deprecations
 *                (the sections an upgrade has to act on)
 *   --json       machine-readable output for tools and coding agents
 *   --changelog  read another file, e.g. node_modules/lexical/CHANGELOG.md
 *
 * With --breaking, versions in the range that have no curated sections
 * (written before the changelog had them) are named on stderr, so they are
 * not skipped silently.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  compareVersions,
  isVersion,
  parseChangelog,
  rangeToJSON,
  renderRange,
  selectRange,
  uncuratedInRange,
} from './changelog.mjs';
import {exitOnEpipe, parseStrict} from './cli.mjs';
import {isMain, ROOT} from './repo.mjs';

const USAGE =
  'usage: pnpm run changelog:range -- --from <version> [--to <version>] [--breaking] [--json] [--changelog <file>]';

/**
 * @param {string[]} argv
 * @returns {number}
 */
export function main(argv) {
  const parsed = parseStrict(argv, {
    breaking: {default: false, type: 'boolean'},
    changelog: {type: 'string'},
    from: {type: 'string'},
    json: {default: false, type: 'boolean'},
    to: {type: 'string'},
  });
  if ('error' in parsed) {
    console.error(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  const {values} = parsed;
  if (!values.from) {
    console.error(`--from is required.\n${USAGE}`);
    return 2;
  }
  for (const flag of ['from', 'to']) {
    if (values[flag] !== undefined && !isVersion(values[flag])) {
      console.error(
        `--${flag} must be a version such as 0.40.0, got "${values[flag]}".\n${USAGE}`,
      );
      return 2;
    }
  }
  if (values.to && compareVersions(values.to, values.from) <= 0) {
    console.error(
      `--to (${values.to}) must be newer than --from (${values.from}).\n${USAGE}`,
    );
    return 2;
  }
  const file = path.resolve(
    values.changelog || path.join(ROOT, 'CHANGELOG.md'),
  );
  if (!fs.existsSync(file)) {
    console.error(`${file} does not exist.\n${USAGE}`);
    return 2;
  }
  const all = parseChangelog(fs.readFileSync(file, 'utf8'));
  const options = {
    breakingOnly: values.breaking,
    from: values.from,
    to: values.to,
  };
  const versions = selectRange(all, options);
  const uncurated = values.breaking ? uncuratedInRange(all, options) : [];
  if (uncurated.length > 0) {
    const names = uncurated.map(v => `v${v}`);
    const list =
      names.length <= 6
        ? names.join(', ')
        : `${names.length} versions (${names.slice(0, 2).join(', ')} ... ${names.slice(-2).join(', ')})`;
    console.error(
      `Note: ${list} ${uncurated.length === 1 ? 'has' : 'have'} no curated sections ` +
        '(the changelog only lists their commits), so --breaking cannot show what changed there. ' +
        'Run without --breaking to read them in full.',
    );
  }
  if (values.json) {
    process.stdout.write(JSON.stringify(rangeToJSON(versions), null, 2) + '\n');
  } else if (versions.length === 0) {
    const upTo = values.to ? ` up to ${values.to}` : '';
    console.log(
      values.breaking
        ? `No breaking changes, behavior changes or deprecations recorded after ${values.from}${upTo}.`
        : `No versions after ${values.from}${upTo}.`,
    );
  } else {
    process.stdout.write(renderRange(versions) + '\n');
  }
  return 0;
}

if (isMain(import.meta.url)) {
  exitOnEpipe();
  process.exitCode = main(process.argv.slice(2));
}
