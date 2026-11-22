/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Filesystem and git access for the changeset scripts: workspace packages,
 * pending changesets, and the pull request each changeset came from.
 * Uses only Node built-ins so CI can run it before `pnpm install`.
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {parseChangesetFile, parseEntry} from './entry.mjs';

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/**
 * @typedef {object} WorkspacePackage
 * @property {string} name npm name
 * @property {string} dir repo-relative directory, e.g. `packages/lexical-list`
 * @property {boolean} isPrivate
 * @property {string} version
 */

/**
 * Every package under `packages/` and `dev-examples/` (the pnpm workspace).
 *
 * @param {string} root
 * @returns {WorkspacePackage[]}
 */
export function readPackages(root) {
  /** @type {WorkspacePackage[]} */
  const out = [];
  for (const parent of ['packages', 'dev-examples']) {
    const abs = path.join(root, parent);
    if (!fs.existsSync(abs)) {
      continue;
    }
    for (const name of fs.readdirSync(abs).sort()) {
      const manifest = path.join(abs, name, 'package.json');
      if (!fs.existsSync(manifest)) {
        continue;
      }
      const json = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (typeof json.name !== 'string') {
        continue;
      }
      out.push({
        dir: `${parent}/${name}`,
        isPrivate: json.private === true,
        name: json.name,
        version: String(json.version || ''),
      });
    }
  }
  return out;
}

/**
 * The packages under `packages/` at a git revision.
 *
 * @param {string} root
 * @param {string} rev
 * @returns {WorkspacePackage[]}
 */
export function readPackagesAt(root, rev) {
  /** @type {WorkspacePackage[]} */
  const out = [];
  const dirs = tryGit(root, ['ls-tree', '--name-only', rev, 'packages/'])
    .split('\n')
    .filter(Boolean);
  for (const dir of dirs) {
    const text = tryGit(root, ['show', `${rev}:${dir}/package.json`]);
    if (text === '') {
      continue;
    }
    try {
      const json = JSON.parse(text);
      if (typeof json.name === 'string') {
        out.push({
          dir,
          isPrivate: json.private === true,
          name: json.name,
          version: String(json.version || ''),
        });
      }
    } catch {
      // Not a package.
    }
  }
  return out;
}

/**
 * @param {WorkspacePackage[]} packages
 * @returns {import('./entry.mjs').ValidationContext}
 */
export function validationContext(packages) {
  return {
    allPackages: new Set(packages.map(p => p.name)),
    publicPackages: new Set(
      packages.filter(p => !p.isPrivate).map(p => p.name),
    ),
  };
}

/**
 * Is `file` (a name inside `.changeset/`) a changeset?
 *
 * @param {string} file
 * @returns {boolean}
 */
export function isChangesetFile(file) {
  return file.endsWith('.md') && file.toLowerCase() !== 'readme.md';
}

/**
 * @typedef {object} PendingChangeset
 * @property {string} file path relative to the repo root
 * @property {string} contents
 * @property {Record<string, string>} releases
 * @property {import('./entry.mjs').Entry} entry
 */

/**
 * @param {string} dir absolute path of the changeset directory
 * @param {string} root
 * @returns {PendingChangeset[]}
 */
export function readPending(dir, root = ROOT) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter(isChangesetFile)
    .sort()
    .map(name => {
      const abs = path.join(dir, name);
      const contents = fs.readFileSync(abs, 'utf8');
      const parsed = parseChangesetFile(contents);
      return {
        contents,
        entry: parseEntry(parsed ? parsed.body : ''),
        file: path.relative(root, abs).split(path.sep).join('/'),
        releases: parsed ? parsed.releases : {},
      };
    });
}

/**
 * @param {string} root
 * @param {string[]} args
 * @returns {string}
 */
export function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * True when the module at `metaUrl` is the script node was asked to run,
 * also when it was started through a symlink.
 *
 * @param {string} metaUrl `import.meta.url` of the calling module
 * @returns {boolean}
 */
export function isMain(metaUrl) {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return (
      fs.realpathSync(process.argv[1]) ===
      fs.realpathSync(fileURLToPath(metaUrl))
    );
  } catch {
    return false;
  }
}

/** The GitHub repository the release links point at. */
export const GITHUB_REPOSITORY =
  process.env.GITHUB_REPOSITORY || 'meta/lexical';

const BOT_RE =
  /\[bot\]$|^(?:dependabot|renovate|github-actions)\b|GitHub Actions Bot/i;

/**
 * @param {string | null | undefined} who a GitHub login or git author name
 * @returns {boolean}
 */
export function isBot(who) {
  return who != null && BOT_RE.test(who);
}

/**
 * @typedef {object} Origin
 * @property {number | null} pr
 * @property {string | null} author `@login` when known, else the git author name
 */

/**
 * @typedef {object} OriginOptions
 * @property {number | null} [prOverride] from a `PR: #123` line
 * @property {string} [token] GitHub token; enables the API fallbacks
 * @property {typeof fetch} [fetchImpl]
 * @property {string} [repository] `owner/name`
 */

/**
 * @param {string} root
 * @param {string[]} args
 * @returns {string}
 */
function tryGit(root, args) {
  try {
    return git(root, args).trim();
  } catch {
    return '';
  }
}

/**
 * @param {OriginOptions} options
 * @param {string} route e.g. `pulls/123`
 * @returns {Promise<any>}
 */
async function githubApi(options, route) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const repository = options.repository || GITHUB_REPOSITORY;
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${repository}/${route}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${options.token}`,
        },
      },
    );
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * The commit that added `file`, following renames inside its directory
 * (not copies: `git log --follow` would also follow a copy, and two
 * changesets often have similar text).
 *
 * @param {string} root
 * @param {string} file repo-relative path
 * @returns {string[]} `[sha, author name, subject]`, or `[]`
 */
function addingCommit(root, file) {
  const dir = path.posix.dirname(file);
  const log = tryGit(root, [
    'log',
    '-M',
    '--diff-filter=AR',
    '--name-status',
    '--format=%x01%H%x00%an%x00%s',
    '--',
    dir === '.' ? file : dir,
  ]);
  let name = file;
  for (const record of log.split('\x01').filter(Boolean)) {
    const [header, ...changes] = record.split('\n');
    for (const change of changes) {
      const [status = '', a, b] = change.split('\t');
      if (status === 'A' && a === name) {
        return header.split('\0');
      }
      if (status.startsWith('R') && b === name && a !== undefined) {
        name = a;
      }
    }
  }
  return [];
}

/**
 * The pull request and author behind a changeset, in order of preference:
 *
 * 1. a `PR: #123` line in the changeset (for changesets added later);
 * 2. the `(#123)` that GitHub squash merges append to the subject of the
 *    commit that added the file (following renames, not copies);
 * 3. the first-parent `Merge pull request #123` that brought that commit
 *    into the branch;
 * 4. with a GitHub token, the pull requests GitHub associates with the
 *    commit.
 *
 * The author is the pull request's GitHub login when a token is available,
 * else the commit's author name. Bots are dropped.
 *
 * @param {string} root
 * @param {string} file repo-relative path
 * @param {OriginOptions} [options]
 * @returns {Promise<Origin>}
 */
export async function resolveOrigin(root, file, options = {}) {
  const [sha = '', authorName = '', subject = ''] = addingCommit(root, file);
  /** @type {number | null} */
  let pr = options.prOverride ?? null;
  if (pr === null) {
    const m = /\(#(\d+)\)\s*$/.exec(subject);
    pr = m ? Number(m[1]) : null;
  }
  if (pr === null && sha) {
    const merges = tryGit(root, [
      'log',
      '--ancestry-path',
      '--first-parent',
      '--merges',
      '--reverse',
      '--format=%s',
      `${sha}..HEAD`,
    ]);
    const m = /^Merge pull request #(\d+)/m.exec(merges);
    pr = m ? Number(m[1]) : null;
  }
  /** @type {string | null} */
  let login = null;
  if (options.token) {
    if (pr === null && sha) {
      const pulls = await githubApi(options, `commits/${sha}/pulls`);
      if (Array.isArray(pulls) && pulls.length > 0) {
        const merged = pulls.find(p => p.merged_at) || pulls[0];
        pr = merged.number;
        login = merged.user ? merged.user.login : null;
      }
    }
    if (pr !== null && login === null) {
      const pull = await githubApi(options, `pulls/${pr}`);
      login = pull && pull.user ? pull.user.login : null;
    }
  }
  const author = login
    ? isBot(login)
      ? null
      : `@${login}`
    : authorName && !isBot(authorName) && options.prOverride == null
      ? authorName
      : null;
  return {author, pr};
}
