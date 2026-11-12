/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Changeset coverage and config consistency, as pure functions.
 *
 * Coverage: a pull request that changes what a published package ships
 * (its `src/` minus tests, its Flow types, or its runtime dependencies)
 * must add a changeset naming that package. Tests, benchmarks, docs, the
 * website, the playground, examples, scripts and private packages need
 * none.
 */

/** @typedef {import('./repo.mjs').WorkspacePackage} WorkspacePackage */

/**
 * @typedef {object} Change
 * @property {string} status git name-status letter(s), e.g. `M`, `A`, `D`, `R100`
 * @property {string} file repo-relative path (the new path for renames)
 * @property {string} [previous] the old path, for renames
 */

const TEST_DIR_RE = /(?:^|\/)__(?:tests|bench|mocks)__\//;
const TEST_FILE_RE = /\.(?:test|bench|spec)\.[cm]?[jt]sx?$/;

/** package.json fields whose change reaches consumers. */
export const CONSUMER_MANIFEST_FIELDS = [
  'bin',
  'browser',
  'dependencies',
  'engines',
  'exports',
  'files',
  'imports',
  'main',
  'module',
  'optionalDependencies',
  'peerDependencies',
  'publishConfig',
  'sideEffects',
  'type',
  'types',
  'typesVersions',
];

/**
 * @param {string} file repo-relative path
 * @param {Map<string, WorkspacePackage>} packagesByDir
 * @returns {{ships: true, package: string, kind: 'source' | 'flow' | 'manifest'} | {ships: false, reason: string}}
 */
export function classifyPath(file, packagesByDir) {
  const m = /^(packages\/[^/]+)\/(.+)$/.exec(file);
  if (!m) {
    return {reason: 'outside the published packages', ships: false};
  }
  const pkg = packagesByDir.get(m[1]);
  if (!pkg) {
    return {reason: 'not a workspace package', ships: false};
  }
  if (pkg.isPrivate) {
    return {reason: `${pkg.name} is private`, ships: false};
  }
  const rel = m[2];
  if (rel === 'package.json') {
    return {kind: 'manifest', package: pkg.name, ships: true};
  }
  if (rel.startsWith('flow/') && rel.endsWith('.js.flow')) {
    return {kind: 'flow', package: pkg.name, ships: true};
  }
  if (!rel.startsWith('src/')) {
    return {reason: 'not shipped source', ships: false};
  }
  if (TEST_DIR_RE.test(rel) || TEST_FILE_RE.test(rel)) {
    return {reason: 'test, benchmark or mock', ships: false};
  }
  return {kind: 'source', package: pkg.name, ships: true};
}

/**
 * The consumer-facing package.json fields that differ.
 *
 * @param {any} before
 * @param {any} after
 * @returns {string[]}
 */
export function manifestDelta(before, after) {
  return CONSUMER_MANIFEST_FIELDS.filter(
    field =>
      JSON.stringify(before ? before[field] : undefined) !==
      JSON.stringify(after ? after[field] : undefined),
  );
}

/**
 * @typedef {object} ChangedChangeset
 * @property {string} file
 * @property {Record<string, string>} releases
 * @property {string | null} [category]
 * @property {string} [text] the whole file
 */

/**
 * @param {object} input
 * @param {Change[]} input.changes
 * @param {WorkspacePackage[]} input.packages packages at the head revision
 * @param {WorkspacePackage[]} [input.basePackages] packages at the base revision
 * @param {(file: string) => string[]} input.manifestFields consumer fields a package.json change touches
 * @param {ChangedChangeset[]} input.changesets changesets this change adds or edits
 * @returns {{required: Map<string, string[]>, covered: Set<string>, removed: string[], missing: string[], problems: string[]}}
 */
export function checkCoverage({
  changes,
  packages,
  basePackages = [],
  manifestFields,
  changesets,
}) {
  // Classify each path by the package that owns it at head, or at base for
  // a package this change deletes or moves.
  const byDir = new Map(basePackages.map(p => [p.dir, p]));
  for (const p of packages) {
    byDir.set(p.dir, p);
  }
  const headNames = new Set(packages.map(p => p.name));
  const removed = basePackages
    .filter(p => !p.isPrivate && !headNames.has(p.name))
    .map(p => p.name);
  /** @type {Map<string, string[]>} */
  const required = new Map();
  for (const change of changes) {
    for (const file of [change.file, change.previous]) {
      if (!file) {
        continue;
      }
      const result = classifyPath(file, byDir);
      if (!result.ships) {
        continue;
      }
      let label = file;
      if (result.kind === 'manifest') {
        const fields = manifestFields(file);
        if (fields.length === 0) {
          continue;
        }
        label = `${file} (${fields.join(', ')})`;
      }
      const list = required.get(result.package) || [];
      if (!list.includes(label)) {
        list.push(label);
      }
      required.set(result.package, list);
    }
  }
  const covered = new Set();
  for (const {releases} of changesets) {
    for (const name of Object.keys(releases)) {
      covered.add(name);
    }
  }
  const missing = [...required.keys()].filter(
    name => !covered.has(name) && !removed.includes(name),
  );
  /** @type {string[]} */
  const problems = [];
  if (missing.length > 0) {
    problems.push(coverageMessage(missing, required));
  }
  for (const name of removed) {
    const announced = changesets.some(
      c => c.category === 'breaking' && (c.text || '').includes(name),
    );
    if (!announced) {
      problems.push(
        [
          `This pull request deletes the published package ${name}. Removing a package breaks everyone who installs it, so add a [breaking] changeset that names it and says what to use instead, e.g.:`,
          '',
          '---',
          "'lexical': minor",
          '---',
          '',
          `[breaking] Remove the ${name} package`,
          '',
          'Migration: what to install or import instead.',
        ].join('\n'),
      );
    }
  }
  return {covered, missing, problems, removed, required};
}

/**
 * A one-line summary and file name derived from a pull request title in the
 * repository's `[packages] Type: title` convention.
 *
 * @param {string} title
 * @returns {{summary: string, slug: string, category: string}}
 */
export function fromPullRequestTitle(title) {
  let rest = title.trim();
  let category = 'fix';
  rest = rest.replace(/^(?:\[[^\]]*\]\s*)+/, '');
  const m =
    /^(Breaking change|Refactor|Feature|Bug Fix|Documentation Update|Chore)\s*:\s*/i.exec(
      rest,
    );
  if (m) {
    const type = m[1].toLowerCase();
    category =
      type === 'feature'
        ? 'feature'
        : type === 'breaking change'
          ? 'breaking'
          : type === 'documentation update'
            ? 'docs'
            : type === 'bug fix'
              ? 'fix'
              : 'chore';
    rest = rest.slice(m[0].length);
  }
  const summary = rest.replace(/\s*\(#\d+\)\s*$/, '').trim();
  const slug =
    summary
      .toLowerCase()
      .replace(/[`'"]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .slice(0, 8)
      .join('-') || 'changeset';
  return {
    category,
    slug,
    summary: summary[0] ? summary[0].toUpperCase() + summary.slice(1) : '',
  };
}

/**
 * The text of a changeset for `packages`, ready to edit.
 *
 * @param {string[]} packages
 * @param {string} category
 * @param {string} summary
 * @returns {string}
 */
export function changesetTemplate(packages, category, summary) {
  const bump = category === 'breaking' ? 'minor' : 'patch';
  const lines = [
    '---',
    ...packages.map(name => `'${name}': ${bump}`),
    '---',
    '',
    `[${category}] ${summary || 'One-line summary, written for people who use Lexical'}`,
  ];
  if (category === 'breaking') {
    lines.push(
      '',
      'Migration: what callers have to change.',
      '',
      'Detect: the symbol, import or CSS class that identifies affected code.',
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * A link that opens GitHub's "new file" page on the pull request's branch
 * with the changeset filled in. Built from the pull request event alone, so
 * it needs no token or extra permissions.
 *
 * @param {{repository: string, ref: string, filename: string, value: string}} input
 * @returns {string}
 */
export function newChangesetUrl({repository, ref, filename, value}) {
  const branch = ref.split('/').map(encodeURIComponent).join('/');
  return (
    `https://github.com/${repository}/new/${branch}` +
    `?filename=${encodeURIComponent(filename)}&value=${encodeURIComponent(value)}`
  );
}

/**
 * @param {string[]} missing
 * @param {Map<string, string[]>} required
 * @returns {string}
 */
function coverageMessage(missing, required) {
  const lines = [
    'This pull request changes published code without a changeset for:',
  ];
  for (const name of missing) {
    const files = required.get(name) || [];
    const more = files.length > 5 ? `, and ${files.length - 5} more` : '';
    lines.push(`  ${name}: ${files.slice(0, 5).join(', ')}${more}`);
  }
  lines.push(
    '',
    'Add a changeset, e.g. with',
    '',
    `  pnpm run changeset:new -- --category fix --packages ${missing.join(',')} --summary "..."`,
    '',
    'which writes a file such as .changeset/short-description.md:',
    '',
    '---',
    ...missing.map(name => `'${name}': patch`),
    '---',
    '',
    '[fix] One-line summary of the change, written for people who use Lexical',
    '',
    'Use [feature], [perf], [docs] or [deprecation] when that fits better. A',
    'breaking change is [breaking] with `minor` instead of `patch`, and needs a',
    '"Migration:" paragraph that tells callers what to change.',
    '',
    'If the change has no effect on people who use Lexical, a maintainer can add',
    'the `skip-changeset` label instead. See "Changesets" in CONTRIBUTING.md.',
  );
  return lines.join('\n');
}

/**
 * Expand changesets-style package globs (`*` within a segment, `!` to
 * exclude what earlier patterns matched).
 *
 * @param {string[]} names
 * @param {string[]} patterns
 * @returns {string[]}
 */
export function matchPackages(names, patterns) {
  const compiled = patterns.map(p => {
    const negated = p.startsWith('!');
    const body = negated ? p.slice(1) : p;
    const re = new RegExp(
      '^' +
        body
          .split('*')
          .map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]*') +
        '$',
    );
    return {negated, re};
  });
  return names.filter(name => {
    let matched = false;
    for (const {negated, re} of compiled) {
      if (!negated && re.test(name)) {
        matched = true;
      } else if (negated && matched && re.test(name)) {
        matched = false;
      }
    }
    return matched;
  });
}

/**
 * `.changeset/config.json` must release every public package together and
 * ignore every private one, so a new package cannot silently fall out of
 * the lockstep release.
 *
 * @param {{fixed?: string[][], ignore?: string[]}} config
 * @param {WorkspacePackage[]} packages
 * @returns {string[]}
 */
export function configProblems(config, packages) {
  const names = packages.map(p => p.name);
  const publicNames = packages.filter(p => !p.isPrivate).map(p => p.name);
  const privateNames = packages.filter(p => p.isPrivate).map(p => p.name);
  /** @type {string[]} */
  const problems = [];
  const groups = config.fixed || [];
  if (groups.length !== 1) {
    problems.push(
      '.changeset/config.json: "fixed" must hold exactly one group with every published package (Lexical releases all packages at one version).',
    );
  } else {
    const fixed = new Set(matchPackages(names, groups[0]));
    const notFixed = publicNames.filter(n => !fixed.has(n));
    const extra = [...fixed].filter(n => !publicNames.includes(n));
    if (notFixed.length > 0) {
      problems.push(
        `.changeset/config.json: published packages missing from the "fixed" group: ${notFixed.join(', ')}.`,
      );
    }
    if (extra.length > 0) {
      problems.push(
        `.changeset/config.json: private packages in the "fixed" group: ${extra.join(', ')}. Exclude them with "!name".`,
      );
    }
  }
  const ignored = new Set(matchPackages(names, config.ignore || []));
  const notIgnored = privateNames.filter(n => !ignored.has(n));
  const wronglyIgnored = [...ignored].filter(n => publicNames.includes(n));
  if (notIgnored.length > 0) {
    problems.push(
      `.changeset/config.json: private packages missing from "ignore": ${notIgnored.join(', ')}.`,
    );
  }
  if (wronglyIgnored.length > 0) {
    problems.push(
      `.changeset/config.json: published packages listed in "ignore": ${wronglyIgnored.join(', ')}.`,
    );
  }
  return problems;
}

/**
 * Parse `git diff --name-status` output.
 *
 * @param {string} output
 * @returns {Change[]}
 */
export function parseNameStatus(output) {
  /** @type {Change[]} */
  const changes = [];
  for (const line of output.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const [status, a, b] = line.split('\t');
    if (b !== undefined) {
      changes.push({file: b, previous: a, status});
    } else {
      changes.push({file: a, status});
    }
  }
  return changes;
}
