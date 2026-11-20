#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Turn the pending changesets into a CHANGELOG.md version block.
 *
 *   node scripts/changesets/release.mjs --version 0.53.0 [--date 2026-10-30]
 *     Validates every pending changeset, prepends the block for that
 *     version to CHANGELOG.md, and deletes the consumed changesets. Runs
 *     from `postversion` on the `latest` channel (`pnpm run
 *     update-changelog`). Refuses when the previous release is missing from
 *     CHANGELOG.md (its release pull request is not merged yet), so a second
 *     run cannot consume the same changesets twice.
 *
 *   node scripts/changesets/release.mjs --preview [--version 0.53.0]
 *     Prints the block that the next release would get (by default for the
 *     next minor when a breaking change is pending, else the next patch)
 *     and changes nothing (`pnpm run changelog`).
 *
 * Prerelease versions (nightly, next, dev) are skipped: their changes stay
 * pending in `.changeset/` until the next `latest` release. The published
 * prerelease packages carry them as `## Unreleased` (see
 * scripts/npm/prepare-release.mjs).
 *
 * With GITHUB_TOKEN set, pull requests and contributor logins that git
 * history cannot provide are looked up through the GitHub API.
 */

import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';

import {
  compareVersions,
  insertVersionBlock,
  parseChangelog,
  renderVersionBlock,
} from './changelog.mjs';
import {validateChangeset} from './entry.mjs';
import {
  git,
  isMain,
  readPackages,
  readPending,
  resolveOrigin,
  ROOT,
  validationContext,
} from './repo.mjs';

/** @typedef {import('./entry.mjs').ReleaseEntry} ReleaseEntry */
/** @typedef {import('./repo.mjs').PendingChangeset} PendingChangeset */
/** @typedef {import('./changelog.mjs').Commit} Commit */

/**
 * @param {PendingChangeset[]} pending
 * @returns {PendingChangeset[]}
 */
export function breakingChangesets(pending) {
  return pending.filter(c => c.entry.category === 'breaking');
}

/**
 * Refuse to publish a breaking change in a patch release.
 *
 * @param {string} version
 * @param {PendingChangeset[]} pending
 * @returns {string | null} the error, or null when the release is allowed
 */
export function patchGuard(version, pending) {
  const [, , patch] = version.replace(/^v/, '').split('-')[0].split('.');
  const breaking = breakingChangesets(pending);
  if (Number(patch) === 0 || breaking.length === 0) {
    return null;
  }
  return (
    `Refusing to release ${version} as a patch: ${breaking.length} pending [breaking] changeset(s) need a minor release:\n` +
    breaking.map(c => `  - ${c.file}: ${c.entry.summary}`).join('\n') +
    '\nRun the release with the "minor" increment instead.'
  );
}

/**
 * The version the pending changesets call for: the next minor when any is
 * breaking, otherwise the next patch.
 *
 * @param {string} current
 * @param {PendingChangeset[]} pending
 * @returns {string}
 */
export function nextVersion(current, pending) {
  const [major, minor, patch] = current
    .replace(/^v/, '')
    .split('-')[0]
    .split('.')
    .map(Number);
  return breakingChangesets(pending).length > 0
    ? `${major}.${minor + 1}.0`
    : `${major}.${minor}.${patch + 1}`;
}

/**
 * The newest stable release before `version`: the newest `vX.Y.Z` tag or
 * LATEST_RELEASE (the latest GitHub release), whichever is newer.
 *
 * @param {string} root
 * @param {string} version
 * @param {string | undefined} latestRelease
 * @returns {string | null} without the leading `v`
 */
export function previousRelease(root, version, latestRelease) {
  let tags = '';
  try {
    tags = git(root, ['tag', '--list', 'v*']);
  } catch {
    tags = '';
  }
  const candidates = [...tags.split('\n'), latestRelease || '']
    .map(t => t.trim().replace(/^v/, ''))
    .filter(t => /^\d+\.\d+\.\d+$/.test(t))
    .filter(t => compareVersions(t, version) < 0)
    .sort(compareVersions);
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

/**
 * Refuse to render twice for the same changesets: the previous release must
 * already be in CHANGELOG.md (its release pull request merged), and the
 * target version must not be.
 *
 * @param {string} changelog
 * @param {string} version
 * @param {string | null} previous
 * @returns {string | null}
 */
export function renderGuard(changelog, version, previous) {
  const versions = parseChangelog(changelog).map(v => v.version);
  if (versions.some(v => compareVersions(v, version) === 0)) {
    return `CHANGELOG.md already has a v${version} section; refusing to add it again.`;
  }
  if (
    previous !== null &&
    !versions.some(v => compareVersions(v, previous) === 0)
  ) {
    return (
      `CHANGELOG.md has no v${previous} section, so the v${previous} release pull request is not merged yet. ` +
      `Merge it (it consumes the changesets for v${previous}) before cutting v${version}; ` +
      'running again now would put the same changesets in both releases.'
    );
  }
  return null;
}

/**
 * Commits from `previous` (exclusive) to HEAD (inclusive), newest first.
 *
 * @param {string} root
 * @param {string | null} previous
 * @returns {Commit[]}
 */
export function commitsSince(root, previous) {
  if (previous === null) {
    return [];
  }
  let out = '';
  try {
    out = git(root, [
      'log',
      '--no-merges',
      '--format=%s%x00%an',
      `v${previous}..HEAD`,
    ]);
  } catch {
    return [];
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [subject, author = ''] = line.split('\0');
      return {author, subject};
    });
}

/**
 * @param {PendingChangeset[]} pending
 * @param {(changeset: PendingChangeset) => Promise<{pr: number | null, author: string | null}>} origin
 * @returns {Promise<ReleaseEntry[]>}
 */
export async function toReleaseEntries(pending, origin) {
  /** @type {ReleaseEntry[]} */
  const entries = [];
  for (const changeset of pending) {
    const {entry} = changeset;
    const {pr, author} = await origin(changeset);
    const contributors =
      entry.contributors.length > 0
        ? entry.contributors.map(handle => `@${handle}`)
        : author
          ? [author]
          : [];
    entries.push({
      category: entry.category || 'chore',
      contributors,
      details: entry.details,
      packages: Object.keys(changeset.releases),
      pr,
      summary: entry.summary,
    });
  }
  return entries;
}

/**
 * @param {string} root
 * @returns {(changeset: PendingChangeset) => ReturnType<typeof resolveOrigin>}
 */
function originResolver(root) {
  return changeset =>
    resolveOrigin(root, changeset.file, {
      prOverride: changeset.entry.pr,
      token: process.env.GITHUB_TOKEN,
    });
}

/**
 * The `## Unreleased` block for the pending changesets, or '' when none are
 * pending. Used for the CHANGELOG.md copy in prerelease packages.
 *
 * @param {string} root
 * @param {string} version the prerelease version being published
 * @returns {Promise<string>}
 */
export async function renderUnreleased(root, version) {
  const pending = readPending(path.join(root, '.changeset'), root);
  if (pending.length === 0) {
    return '';
  }
  const entries = await toReleaseEntries(pending, originResolver(root));
  return renderVersionBlock({
    date: '',
    entries,
    heading: '## Unreleased',
    intro: `Merged after the latest stable release and included in ${version}. These entries move into a version section when the next stable release is cut.`,
    version,
  });
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const {values} = parseArgs({
    args: argv,
    options: {
      changelog: {type: 'string'},
      date: {type: 'string'},
      dir: {type: 'string'},
      preview: {default: false, type: 'boolean'},
      root: {default: ROOT, type: 'string'},
      version: {type: 'string'},
    },
  });
  const root = path.resolve(values.root);
  const dir = path.resolve(root, values.dir || '.changeset');
  const changelogPath = path.resolve(root, values.changelog || 'CHANGELOG.md');
  const rootVersion = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  ).version;
  const pending = readPending(dir, root);
  const version = (
    values.version ||
    (values.preview
      ? nextVersion(rootVersion, pending)
      : process.env.npm_package_version || rootVersion)
  ).replace(/^v/, '');

  if (!values.preview && version.includes('-')) {
    console.log(
      `Skipping CHANGELOG.md for prerelease ${version}; changesets stay pending in .changeset/.`,
    );
    return 0;
  }

  const ctx = validationContext(readPackages(root));
  const errors = pending.flatMap(
    c => validateChangeset(c.file, c.contents, ctx).errors,
  );
  if (errors.length > 0) {
    console.error(
      `Cannot build the changelog: ${errors.length} problem(s) in pending changesets:\n` +
        errors.map(e => `  - ${e}`).join('\n'),
    );
    return 1;
  }
  const existing = fs.existsSync(changelogPath)
    ? fs.readFileSync(changelogPath, 'utf8')
    : '';
  const previous = previousRelease(root, version, process.env.LATEST_RELEASE);
  if (!values.preview) {
    const problem =
      patchGuard(version, pending) || renderGuard(existing, version, previous);
    if (problem) {
      console.error(problem);
      return 1;
    }
  }

  const entries = await toReleaseEntries(pending, originResolver(root));
  const block = renderVersionBlock({
    commits: commitsSince(root, previous),
    date: values.date || new Date().toISOString().slice(0, 10),
    entries,
    version,
  });

  if (values.preview) {
    process.stdout.write(block);
    return 0;
  }

  fs.writeFileSync(changelogPath, insertVersionBlock(existing, block));
  for (const changeset of pending) {
    fs.rmSync(path.join(root, changeset.file));
  }
  console.log(
    `Added v${version} to ${path.relative(root, changelogPath)} from ${pending.length} changeset(s).`,
  );
  return 0;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
