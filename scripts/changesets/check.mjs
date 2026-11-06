#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * `pnpm run check-changesets` — validate pending changesets.
 *
 *   node scripts/changesets/check.mjs [--dir <changeset dir>]
 *     Validates every changeset (category, bump, required sections,
 *     packages) and `.changeset/config.json`. Problems fail the run.
 *
 *   node scripts/changesets/check.mjs --base <ref> [--head <ref>] [--coverage warn|error]
 *     Also checks coverage: a change to a published package's shipped code
 *     between merge-base(base, head) and head needs a changeset naming that
 *     package, and deleting a published package needs a [breaking] one.
 *     `--coverage` (or CHANGESET_COVERAGE) decides whether missing coverage
 *     fails the run (`error`, the default) or is only reported (`warn`). In
 *     GitHub Actions, coverage problems are also written to the job summary
 *     and as annotations. SKIP_CHANGESET=true (set by CI for the
 *     `skip-changeset` label) skips coverage.
 */

import fs from 'node:fs';
import path from 'node:path';

import {parseStrict} from './cli.mjs';
import {
  changesetTemplate,
  checkCoverage,
  configProblems,
  fromPullRequestTitle,
  manifestDelta,
  newChangesetUrl,
  parseNameStatus,
} from './coverage.mjs';
import {parseChangesetFile, parseEntry, validateChangeset} from './entry.mjs';
import {
  git,
  isChangesetFile,
  isMain,
  readPackages,
  readPackagesAt,
  readPending,
  ROOT,
  validationContext,
} from './repo.mjs';

const USAGE =
  'usage: node scripts/changesets/check.mjs [--dir <dir>] [--base <ref> [--head <ref>] [--coverage warn|error]] [--root <dir>]';

/**
 * @param {string} root
 * @param {string} rev
 * @param {string} file
 * @returns {any}
 */
function readJsonAt(root, rev, file) {
  try {
    return JSON.parse(git(root, ['show', `${rev}:${file}`]));
  } catch {
    return null;
  }
}

/**
 * Escape a message for a GitHub Actions workflow command.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeAnnotation(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/**
 * A link that opens the changeset for the missing packages, prefilled, on
 * the pull request's branch. Uses HEAD_REPO, HEAD_REF and PR_TITLE, which
 * the workflow copies from the pull request event.
 *
 * @param {string[]} missing
 * @returns {string | null}
 */
export function addChangesetLink(missing) {
  const {HEAD_REPO, HEAD_REF, PR_TITLE} = process.env;
  if (!HEAD_REPO || !HEAD_REF || missing.length === 0) {
    return null;
  }
  const {category, slug, summary} = fromPullRequestTitle(PR_TITLE || '');
  return newChangesetUrl({
    filename: `.changeset/${slug}.md`,
    ref: HEAD_REF,
    repository: HEAD_REPO,
    value: changesetTemplate(missing, category, summary),
  });
}

/**
 * Report coverage problems where a pull request author will see them.
 *
 * @param {string[]} problems
 * @param {'warn' | 'error'} mode
 * @param {string | null} link prefilled "add changeset" link
 */
function reportToGitHub(problems, mode, link) {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    return;
  }
  const level = mode === 'error' ? 'error' : 'warning';
  const suffix = link ? `\n\nAdd it in the browser: ${link}` : '';
  for (const problem of problems) {
    console.log(
      `::${level} title=Missing changeset::${escapeAnnotation(problem + suffix)}`,
    );
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    fs.appendFileSync(
      summary,
      [
        '## Changeset coverage',
        '',
        mode === 'error'
          ? 'This pull request needs a changeset:'
          : 'This pull request probably needs a changeset (reported only; it does not fail the check yet):',
        '',
        ...problems.map(p => '```\n' + p + '\n```'),
        '',
        ...(link
          ? [
              `[Add the changeset in the browser](${link}) (opens a prefilled file on this pull request's branch; edit the summary before committing).`,
              '',
            ]
          : []),
        'See "Changesets" in CONTRIBUTING.md.',
        '',
      ].join('\n'),
    );
  }
}

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv) {
  const parsed = parseStrict(argv, {
    base: {type: 'string'},
    coverage: {type: 'string'},
    dir: {type: 'string'},
    head: {default: 'HEAD', type: 'string'},
    root: {default: ROOT, type: 'string'},
  });
  if ('error' in parsed) {
    console.error(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  const {values} = parsed;
  const coverageMode =
    values.coverage || process.env.CHANGESET_COVERAGE || 'error';
  if (coverageMode !== 'warn' && coverageMode !== 'error') {
    console.error(
      `--coverage must be "warn" or "error", got "${coverageMode}".\n${USAGE}`,
    );
    return 2;
  }
  const root = path.resolve(values.root);
  const dir = path.resolve(root, values.dir || '.changeset');
  const packages = readPackages(root);
  const ctx = validationContext(packages);

  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  const configPath = path.join(root, '.changeset', 'config.json');
  if (fs.existsSync(configPath)) {
    errors.push(
      ...configProblems(
        JSON.parse(fs.readFileSync(configPath, 'utf8')),
        packages,
      ),
    );
  } else {
    errors.push('.changeset/config.json is missing.');
  }

  const pending = readPending(dir, root);
  for (const changeset of pending) {
    const result = validateChangeset(changeset.file, changeset.contents, ctx);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  let coverageNote = '';
  /** @type {string[]} */
  let coverageProblems = [];
  if (values.base) {
    if (process.env.SKIP_CHANGESET === 'true') {
      coverageNote = '; coverage skipped (skip-changeset label)';
    } else {
      const head = values.head;
      const mergeBase = git(root, ['merge-base', values.base, head]).trim();
      const changes = parseNameStatus(
        git(root, ['diff', '--name-status', '-M', mergeBase, head]),
      );
      const changesets = changes
        .filter(
          c =>
            !c.status.startsWith('D') &&
            c.file.startsWith('.changeset/') &&
            isChangesetFile(path.posix.basename(c.file)),
        )
        .map(c => {
          const text = git(root, ['show', `${head}:${c.file}`]);
          const file = parseChangesetFile(text);
          return {
            category: file ? parseEntry(file.body).category : null,
            file: c.file,
            releases: file ? file.releases : {},
            text,
          };
        });
      const result = checkCoverage({
        basePackages: readPackagesAt(root, mergeBase),
        changes,
        changesets,
        manifestFields: file =>
          manifestDelta(
            readJsonAt(root, mergeBase, file),
            readJsonAt(root, head, file),
          ),
        packages,
      });
      coverageProblems = result.problems;
      const shipped = [...result.required.keys()];
      if (coverageProblems.length > 0) {
        reportToGitHub(
          coverageProblems,
          coverageMode,
          addChangesetLink(result.missing),
        );
        coverageNote =
          coverageMode === 'warn'
            ? `; coverage: ${coverageProblems.length} warning(s), reported only`
            : '';
      } else {
        coverageNote = shipped.length
          ? `; coverage: ${shipped.join(', ')} changed, each named by a changeset`
          : '; coverage: no published code changed';
      }
    }
  }

  for (const warning of warnings) {
    console.warn(`warning: ${warning}`);
  }
  const failing =
    coverageMode === 'error' ? [...errors, ...coverageProblems] : errors;
  if (coverageMode === 'warn') {
    for (const problem of coverageProblems) {
      console.warn(`warning: ${problem}`);
    }
  }
  if (failing.length > 0) {
    console.error(`\nChangeset check found ${failing.length} problem(s):\n`);
    for (const error of failing) {
      const lines = error.split('\n');
      console.error(
        ['- ' + lines[0], ...lines.slice(1).map(l => (l ? `  ${l}` : ''))].join(
          '\n',
        ),
      );
    }
    console.error('\nSee .changeset/README.md for the format.\n');
    return 1;
  }
  console.log(
    `Changeset check passed: ${pending.length} pending changeset(s) valid${coverageNote}.`,
  );
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
