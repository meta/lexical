#!/usr/bin/env node

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import fs from 'fs-extra';
import path from 'node:path';

import {insertVersionBlock} from '../changesets/changelog.mjs';
import {renderUnreleased} from '../changesets/release.mjs';
import {ROOT} from '../changesets/repo.mjs';
import {packagesManager} from '../shared/packagesManager.mjs';

/**
 * Recursively collect leaf string values from a package.json `exports`
 * entry. Conditional maps nest arbitrarily ({ "import": { "types": "..." } }).
 *
 * @param {unknown} entry
 * @param {Set<string>} acc
 */
function collectExportPaths(entry, acc) {
  if (typeof entry === 'string') {
    acc.add(entry);
  } else if (Array.isArray(entry)) {
    entry.forEach(item => collectExportPaths(item, acc));
  } else if (entry && typeof entry === 'object') {
    for (const value of Object.values(entry)) {
      collectExportPaths(value, acc);
    }
  }
}

/**
 * Confirm that every file referenced by the package's `exports` map (and
 * the legacy `main`/`module`/`types` fields) exists on disk. Catches the
 * common footgun of publishing a dev-only build that lacks the prod
 * variants the exports map promises.
 *
 * @param {import('../shared/PackageMetadata.mjs').PackageMetadata} pkg
 * @returns {string[]} missing paths (empty when the package is fine)
 */
function findMissingExportTargets(pkg) {
  const referenced = new Set();
  collectExportPaths(pkg.packageJson.exports, referenced);
  for (const field of ['main', 'module', 'types']) {
    const v = pkg.packageJson[field];
    if (typeof v === 'string') {
      referenced.add(v);
    }
  }
  const missing = [];
  for (const rel of referenced) {
    if (!rel.startsWith('./')) {
      continue;
    }
    if (!fs.existsSync(pkg.resolve(rel))) {
      missing.push(rel);
    }
  }
  return missing.sort();
}

/**
 * Ship the full release history with the core package (see the `files`
 * field that scripts/updateVersion.mjs writes for `lexical`). A prerelease
 * (nightly, next, dev) also lists the pending changesets as `## Unreleased`
 * in that copy; the repository's CHANGELOG.md is left alone.
 */
async function copyChangelog() {
  const core = packagesManager.getPackageByNpmName('lexical');
  const {version} = core.packageJson;
  let changelog = fs.readFileSync(path.resolve('CHANGELOG.md'), 'utf8');
  if (String(version).includes('-')) {
    const unreleased = await renderUnreleased(ROOT, version);
    if (unreleased !== '') {
      changelog = insertVersionBlock(changelog, unreleased);
      console.log(`[lexical] CHANGELOG.md lists pending changes as Unreleased`);
    }
  }
  fs.writeFileSync(core.resolve('CHANGELOG.md'), changelog);
}

/**
 * Verify each public package is ready to publish: README, LICENSE, and
 * every file referenced by `exports` must exist. `pnpm publish` rewrites
 * `workspace:*` automatically, so no in-place package.json mutation is
 * required here.
 */
function prepareForRelease() {
  let failed = false;
  for (const pkg of packagesManager.getPublicPackages()) {
    const required = ['package.json', 'README.md', 'LICENSE'];
    const missingRequired = required.filter(
      fn => !fs.existsSync(pkg.resolve(fn)),
    );
    if (missingRequired.length > 0) {
      console.error(
        `[${pkg.getNpmName()}] missing required file(s): ${missingRequired.join(', ')}`,
      );
      failed = true;
      continue;
    }
    const missing = findMissingExportTargets(pkg);
    if (missing.length > 0) {
      console.error(
        `[${pkg.getNpmName()}] package.json references files that are not present in ${path.relative(
          process.cwd(),
          pkg.resolve('.'),
        )}:\n  ${missing.join('\n  ')}\nDid you run \`pnpm run build-release\`?`,
      );
      failed = true;
      continue;
    }
    console.log(`[${pkg.getNpmName()}] OK (${pkg.packageJson.version})`);
  }
  if (failed) {
    process.exit(1);
  }
}

await copyChangelog();
prepareForRelease();
