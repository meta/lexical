#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * `pnpm run changeset:new -- --category fix --packages lexical,@lexical/list --summary "..."`
 *
 * Write a changeset in the format .changeset/README.md describes.
 *
 *   --category     breaking | deprecation | feature | fix | perf | docs | chore
 *   --packages     comma-separated npm names of published packages
 *   --summary      one line, written for people who use Lexical
 *   --pr           pull request number, only when the change landed in a
 *                  different pull request than this changeset
 *   --contributor  GitHub handle(s) to credit, comma-separated
 *   --migration, --detect, --codemod, --verify, --replacement, --removal
 *                  fill in those paragraphs; a [breaking] or [deprecation]
 *                  entry without them gets TODO lines to edit, which the
 *                  check rejects until they are filled in
 *   --name         file name (default: derived from the summary)
 */

import fs from 'node:fs';
import path from 'node:path';

import {parseStrict} from './cli.mjs';
import {CATEGORIES, normalizeCategory, validateChangeset} from './entry.mjs';
import {isMain, readPackages, ROOT, validationContext} from './repo.mjs';

const USAGE = [
  'usage: pnpm run changeset:new -- --category <category> --packages <a,b> --summary "<one line>"',
  '         [--pr <number>] [--contributor <handle>] [--migration "..."] [--detect "..."]',
  '         [--codemod "..."] [--verify "..."] [--replacement "..."] [--removal "..."] [--name <file>]',
  `categories: ${CATEGORIES.map(c => c.key).join(', ')}`,
].join('\n');

/**
 * @param {string} summary
 * @returns {string}
 */
export function slugify(summary) {
  return (
    summary
      .toLowerCase()
      .replace(/[`'"]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .slice(0, 8)
      .join('-') || 'change'
  );
}

/**
 * @typedef {object} NewChangeset
 * @property {import('./entry.mjs').Category} category
 * @property {string[]} packages
 * @property {string} summary
 * @property {number} [pr]
 * @property {string[]} [contributors]
 * @property {Partial<Record<'migration' | 'detect' | 'codemod' | 'replacement' | 'removal' | 'verify', string>>} [sections]
 */

/**
 * Build the changeset file contents.
 *
 * @param {NewChangeset} input
 * @returns {string}
 */
export function formatChangeset({
  category,
  packages,
  summary,
  pr,
  contributors = [],
  sections = {},
}) {
  const bump = category === 'breaking' ? 'minor' : 'patch';
  const lines = [
    '---',
    ...packages.map(name => `'${name}': ${bump}`),
    '---',
    '',
    `[${category}] ${summary.trim()}`,
  ];
  if (contributors.length > 0) {
    lines.push(contributors.map(c => `@${c.replace(/^@/, '')}`).join(' '));
  }
  if (pr !== undefined) {
    lines.push(`PR: #${pr}`);
  }
  /** @type {Array<[string, string, boolean]>} */
  const wanted = [];
  if (category === 'breaking') {
    wanted.push(
      ['Migration', sections.migration || '', true],
      ['Detect', sections.detect || '', true],
      ['Codemod', sections.codemod || '', false],
      ['Verify', sections.verify || '', false],
    );
  } else if (category === 'deprecation') {
    wanted.push(
      ['Replacement', sections.replacement || '', true],
      ['Removal', sections.removal || '', true],
    );
  } else {
    for (const [label, key] of /** @type {const} */ ([
      ['Migration', 'migration'],
      ['Detect', 'detect'],
      ['Codemod', 'codemod'],
      ['Replacement', 'replacement'],
      ['Removal', 'removal'],
      ['Verify', 'verify'],
    ])) {
      if (sections[key]) {
        wanted.push([label, sections[key] || '', false]);
      }
    }
  }
  for (const [label, value, required] of wanted) {
    if (value) {
      lines.push('', `${label}: ${value.trim()}`);
    } else if (required) {
      lines.push('', `${label}: TODO`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
export function main(argv) {
  const parsed = parseStrict(argv, {
    category: {type: 'string'},
    codemod: {type: 'string'},
    contributor: {type: 'string'},
    detect: {type: 'string'},
    dir: {type: 'string'},
    migration: {type: 'string'},
    name: {type: 'string'},
    packages: {type: 'string'},
    pr: {type: 'string'},
    removal: {type: 'string'},
    replacement: {type: 'string'},
    root: {default: ROOT, type: 'string'},
    summary: {type: 'string'},
    verify: {type: 'string'},
  });
  if ('error' in parsed) {
    console.error(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  const {values} = parsed;
  const category = normalizeCategory(values.category);
  if (!category || !values.packages || !values.summary) {
    console.error(
      `${!category ? `Unknown or missing --category${values.category ? ` "${values.category}"` : ''}. ` : ''}${!values.packages ? '--packages is required. ' : ''}${!values.summary ? '--summary is required.' : ''}\n${USAGE}`,
    );
    return 2;
  }
  if (values.pr !== undefined && !/^#?\d+$/.test(values.pr)) {
    console.error(`--pr must be a number, got "${values.pr}".\n${USAGE}`);
    return 2;
  }
  const root = path.resolve(values.root);
  const dir = path.resolve(root, values.dir || '.changeset');
  const contents = formatChangeset({
    category,
    contributors: values.contributor
      ? values.contributor
          .split(',')
          .map((/** @type {string} */ s) => s.trim())
          .filter(Boolean)
      : [],
    packages: values.packages
      .split(',')
      .map((/** @type {string} */ s) => s.trim())
      .filter(Boolean),
    pr:
      values.pr !== undefined ? Number(values.pr.replace('#', '')) : undefined,
    sections: {
      codemod: values.codemod,
      detect: values.detect,
      migration: values.migration,
      removal: values.removal,
      replacement: values.replacement,
      verify: values.verify,
    },
    summary: values.summary,
  });
  const file = path.join(
    dir,
    `${(values.name || slugify(values.summary)).replace(/\.md$/, '')}.md`,
  );
  const display = path.relative(root, file);
  const {errors, warnings} = validateChangeset(
    display,
    contents,
    validationContext(readPackages(root)),
  );
  const blocking = errors.filter(e => !/still a placeholder/.test(e));
  if (blocking.length > 0) {
    console.error(
      `Not written:\n${blocking.map(e => `  - ${e}`).join('\n')}\n${USAGE}`,
    );
    return 1;
  }
  if (fs.existsSync(file)) {
    console.error(`${display} already exists; pass --name to pick another.`);
    return 1;
  }
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(file, contents);
  console.log(`Wrote ${display}:\n\n${contents}`);
  for (const warning of warnings) {
    console.warn(`warning: ${warning}`);
  }
  if (errors.length > 0) {
    console.log(
      `Replace the TODO line(s) in ${display} before committing; \`pnpm run check-changesets\` rejects them.` +
        (category === 'breaking'
          ? '\n  Migration: what callers have to change, with before/after code if it helps.\n  Detect: what identifies affected code, usually the symbol, import or CSS class.\n  Codemod (optional): a codemod, or why there is none.\n  Verify (optional): what to test when nothing fails to compile.'
          : '\n  Replacement: what to use instead (or "none" and why).\n  Removal: a version, "no earlier than v0.NN", or "not scheduled".'),
    );
  }
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
