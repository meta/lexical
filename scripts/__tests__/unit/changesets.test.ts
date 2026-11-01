/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';

import {
  changesetTemplate,
  checkCoverage,
  classifyPath,
  configProblems,
  fromPullRequestTitle,
  manifestDelta,
  matchPackages,
  newChangesetUrl,
  parseNameStatus,
} from '../../changesets/coverage.mjs';
import {
  isBehaviorChange,
  isRemoval,
  normalizeCategory,
  parseChangesetFile,
  parseEntry,
  validateChangeset,
} from '../../changesets/entry.mjs';
import {
  formatChangeset,
  main as newChangeset,
  slugify,
} from '../../changesets/new.mjs';
import {readPackages, ROOT} from '../../changesets/repo.mjs';

const FIXTURES = path.join(__dirname, 'fixtures', 'changesets');

const PACKAGES = [
  {
    dir: 'packages/lexical',
    isPrivate: false,
    name: 'lexical',
    version: '0.52.0',
  },
  {
    dir: 'packages/lexical-list',
    isPrivate: false,
    name: '@lexical/list',
    version: '0.52.0',
  },
  {
    dir: 'packages/lexical-table',
    isPrivate: false,
    name: '@lexical/table',
    version: '0.52.0',
  },
  {
    dir: 'packages/lexical-html',
    isPrivate: false,
    name: '@lexical/html',
    version: '0.52.0',
  },
  {
    dir: 'packages/lexical-playground',
    isPrivate: true,
    name: 'lexical-playground',
    version: '0.52.0',
  },
  {
    dir: 'packages/lexical-website',
    isPrivate: true,
    name: '@lexical/website',
    version: '0.52.0',
  },
];

const CTX = {
  allPackages: new Set(PACKAGES.map(p => p.name)),
  publicPackages: new Set(PACKAGES.filter(p => !p.isPrivate).map(p => p.name)),
};

function fixture(group: string, name: string): string {
  return fs.readFileSync(path.join(FIXTURES, group, name), 'utf8');
}

function validate(contents: string) {
  return validateChangeset('test.md', contents, CTX);
}

describe('changeset entry format', () => {
  it('normalizes categories and aliases', () => {
    expect(normalizeCategory('feat')).toBe('feature');
    expect(normalizeCategory(' Bug Fix ')).toBe('fix');
    expect(normalizeCategory('deprecated')).toBe('deprecation');
    expect(normalizeCategory('Breaking Change')).toBe('breaking');
    expect(normalizeCategory('performance')).toBe('perf');
    expect(normalizeCategory('refactor')).toBe('chore');
    expect(normalizeCategory('nonsense')).toBeNull();
  });

  it('parses frontmatter releases', () => {
    expect(
      parseChangesetFile(fixture('valid', 'remove-get-common-ancestor.md'))
        ?.releases,
    ).toEqual({lexical: 'minor'});
    expect(parseChangesetFile('no frontmatter')).toBeNull();
  });

  it('parses the summary, contributors and labeled sections', () => {
    const parsed = parseChangesetFile(
      fixture('valid', 'remove-get-common-ancestor.md'),
    );
    const entry = parseEntry(parsed!.body);
    expect(entry.category).toBe('breaking');
    expect(entry.summary).toBe('Remove `LexicalNode.getCommonAncestor`');
    expect(entry.contributors).toEqual(['contributor']);
    expect(entry.sections.migration).toContain(
      'use `$getCommonAncestor` from `lexical`.',
    );
    // The code block belongs to the Migration section.
    expect(entry.sections.migration).toContain(
      'const ancestor = a.getCommonAncestor(b);',
    );
    expect(entry.sections.detect).toBe(
      'calls to `.getCommonAncestor(` on nodes.',
    );
    expect(entry.sections.codemod).toBe('none; each call site needs review.');
    expect(entry.details.startsWith('Migration:')).toBe(true);
  });

  it('does not treat labels inside code fences as sections', () => {
    const entry = parseEntry(
      '[breaking] X\n\nMigration:\n\n```md\nDetect: not a label\n```',
    );
    expect(entry.sections.detect).toBeUndefined();
    expect(entry.sections.migration).toContain('Detect: not a label');
  });

  it('only treats capitalized labels as sections', () => {
    const entry = parseEntry(
      '[breaking] X\n\nNot a drop-in\nreplacement: prose that wraps.\n\nMigration: do Y.',
    );
    expect(entry.sections).toEqual({migration: 'do Y.'});
  });

  it('accepts every valid fixture', () => {
    for (const name of fs.readdirSync(path.join(FIXTURES, 'valid'))) {
      expect(validate(fixture('valid', name))).toEqual({
        errors: [],
        warnings: [],
      });
    }
  });

  it('requires Migration and Detect on breaking entries, and minor bumps', () => {
    const {errors} = validate(
      fixture('invalid', 'breaking-without-migration.md'),
    );
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/is \[breaking\] but declares "patch"/);
    expect(errors[1]).toMatch(/need a "Migration:" paragraph/);
    expect(errors[2]).toMatch(/need a "Detect:" paragraph/);
  });

  it('rejects private packages and major bumps', () => {
    const {errors} = validate(fixture('invalid', 'private-package-major.md'));
    expect(errors.join('\n')).toMatch(/"lexical-playground" is private/);
    expect(errors.join('\n')).toMatch(/declares "major"/);
  });

  it('requires a category and warns about hand-written PR numbers', () => {
    const {errors, warnings} = validate(fixture('invalid', 'no-category.md'));
    expect(errors).toEqual([
      expect.stringMatching(/the first line must start with a category/),
    ]);
    expect(warnings).toEqual([expect.stringMatching(/drop the "\(#123\)"/)]);
  });

  it('rejects minor bumps for non-breaking categories', () => {
    const {errors} = validate(
      "---\n'@lexical/list': minor\n---\n\n[feature] Add a thing\n",
    );
    expect(errors).toEqual([
      expect.stringMatching(/declares "minor" but the category is \[feature\]/),
    ]);
  });

  it('rejects unknown packages, unknown categories and wrapped summaries', () => {
    const {errors} = validate(
      "---\n'@lexical/nope': patch\n---\n\n[shiny] One\nline two\n",
    );
    expect(errors.join('\n')).toMatch(/unknown package "@lexical\/nope"/);
    expect(errors.join('\n')).toMatch(/unknown category "\[shiny\]"/);
    expect(errors.join('\n')).toMatch(/must be a single line/);
  });

  it('explains an empty frontmatter and points at skip-changeset', () => {
    expect(validate('---\n---\n\n[chore] Nothing\n').errors).toEqual([
      expect.stringMatching(/lists no packages.*`skip-changeset` label/),
    ]);
  });

  it('rejects comments, duplicate packages and unreadable lines', () => {
    const {errors} = validate(
      "---\n# a comment\n'lexical': patch\nlexical: patch\nnot a package line\n---\n\n[fix] X\n",
    );
    expect(errors).toEqual([
      expect.stringMatching(/comments are not supported in the frontmatter/),
      expect.stringMatching(/"lexical" is listed more than once/),
      expect.stringMatching(
        /cannot read the frontmatter line "not a package line"/,
      ),
    ]);
  });

  it('rejects Markdown headings outside code blocks', () => {
    expect(
      validate(
        "---\n'lexical': patch\n---\n\n[fix] X\n\n```md\n# fine in code\n```\n",
      ).errors,
    ).toEqual([]);
    expect(
      validate("---\n'lexical': patch\n---\n\n[fix] X\n\n## Details\n").errors,
    ).toEqual([expect.stringMatching(/Markdown headings \("## Details"\)/)]);
  });

  it('rejects placeholder sections', () => {
    expect(
      validate(
        "---\n'lexical': minor\n---\n\n[breaking] X\n\nMigration: TODO\n\nDetect: `x`\n",
      ).errors,
    ).toEqual([
      expect.stringMatching(/"Migration:" paragraph is still a placeholder/),
    ]);
  });

  it('reads Detect, Codemod and Verify sections', () => {
    expect(
      parseEntry(
        '[breaking] X\n\nMigration: none.\n\nDetect: `.x(`\n\nVerify: paste.',
      ).sections,
    ).toEqual({detect: '`.x(`', migration: 'none.', verify: 'paste.'});
  });

  it('reads a PR: line under the summary', () => {
    const entry = parseEntry('[fix] X\n@someone\nPR: #9316\n\nDetails.');
    expect(entry).toMatchObject({
      contributors: ['someone'],
      details: 'Details.',
      multiLineSummary: false,
      pr: 9316,
    });
  });

  it('requires a replacement and a removal plan on deprecations', () => {
    const deprecation = (removal: string) =>
      validate(
        `---\n'@lexical/table': patch\n---\n\n[deprecation] Deprecate X\n\nReplacement: \`Y\`.\n${removal}`,
      ).errors;
    expect(
      validate(
        "---\n'@lexical/table': patch\n---\n\n[deprecation] Deprecate X\n",
      ).errors,
    ).toEqual([
      expect.stringMatching(/need a "Replacement:" paragraph/),
      expect.stringMatching(/need a "Removal:" paragraph/),
    ]);
    for (const ok of [
      'v0.60.0',
      'v0.60',
      'no earlier than v0.60.0.',
      'Not scheduled; it still works.',
      'v0.46.0 ([#8704](https://github.com/meta/lexical/pull/8704)).',
    ]) {
      expect(deprecation(`\nRemoval: ${ok}\n`), ok).toEqual([]);
    }
    expect(deprecation('\nRemoval: soon\n')).toEqual([
      expect.stringMatching(/"Removal: soon" must start with a version/),
    ]);
    expect(deprecation('\nRemoval: TODO\n')).toEqual([
      expect.stringMatching(/"Removal:" paragraph is still a placeholder/),
    ]);
    expect(isRemoval('v0.60.0x')).toBe(false);
  });

  it('treats a non-breaking entry with Verify as a behavior change', () => {
    expect(isBehaviorChange({category: 'fix', details: 'Verify: paste.'})).toBe(
      true,
    );
    expect(isBehaviorChange({category: 'fix', details: 'Details.'})).toBe(
      false,
    );
    expect(
      isBehaviorChange({
        category: 'breaking',
        details: 'Migration: x.\n\nDetect: y.\n\nVerify: z.',
      }),
    ).toBe(false);
  });
});

describe('changeset coverage', () => {
  const byDir = new Map(PACKAGES.map(p => [p.dir, p]));

  it('classifies shipped and unshipped paths', () => {
    const ships = (file: string) => classifyPath(file, byDir).ships;
    expect(ships('packages/lexical-list/src/index.ts')).toBe(true);
    expect(ships('packages/lexical-list/flow/LexicalList.js.flow')).toBe(true);
    expect(ships('packages/lexical-list/package.json')).toBe(true);
    expect(ships('packages/lexical-list/src/__tests__/unit/a.test.ts')).toBe(
      false,
    );
    expect(ships('packages/lexical-list/src/foo.test.ts')).toBe(false);
    expect(ships('packages/lexical-list/src/__bench__/a.bench.ts')).toBe(false);
    expect(ships('packages/lexical-list/README.md')).toBe(false);
    expect(ships('packages/lexical-playground/src/App.tsx')).toBe(false);
    expect(ships('packages/lexical-website/docs/intro.md')).toBe(false);
    expect(ships('scripts/build.mjs')).toBe(false);
    expect(ships('examples/react-rich/src/App.tsx')).toBe(false);
  });

  it('only counts consumer-facing package.json fields', () => {
    expect(
      manifestDelta({scripts: {a: '1'}, version: '1'}, {version: '2'}),
    ).toEqual([]);
    expect(
      manifestDelta({dependencies: {yjs: '1'}}, {dependencies: {yjs: '2'}}),
    ).toEqual(['dependencies']);
    expect(
      manifestDelta(
        {files: ['dist'], type: 'commonjs'},
        {
          browser: {},
          files: ['dist', 'CHANGELOG.md'],
          imports: {},
          publishConfig: {},
          type: 'module',
          typesVersions: {},
        },
      ),
    ).toEqual([
      'browser',
      'files',
      'imports',
      'publishConfig',
      'type',
      'typesVersions',
    ]);
  });

  it('requires a [breaking] changeset naming a deleted package', () => {
    const base = [
      ...PACKAGES,
      {
        dir: 'packages/lexical-old',
        isPrivate: false,
        name: '@lexical/old',
        version: '0.52.0',
      },
    ];
    const changes = [
      {file: 'packages/lexical-old/src/index.ts', status: 'D'},
      {file: 'packages/lexical-old/package.json', status: 'D'},
    ];
    const without = checkCoverage({
      basePackages: base,
      changes,
      changesets: [],
      manifestFields: () => ['main'],
      packages: PACKAGES,
    });
    expect(without.removed).toEqual(['@lexical/old']);
    expect(without.problems).toEqual([
      expect.stringMatching(/deletes the published package @lexical\/old/),
    ]);
    const withBreaking = checkCoverage({
      basePackages: base,
      changes,
      changesets: [
        {
          category: 'breaking',
          file: '.changeset/remove-old.md',
          releases: {lexical: 'minor'},
          text: "---\n'lexical': minor\n---\n\n[breaking] Remove @lexical/old\n\nMigration: use lexical.\n",
        },
      ],
      manifestFields: () => ['main'],
      packages: PACKAGES,
    });
    expect(withBreaking.problems).toEqual([]);
  });

  it('treats a moved package as a change to that package, not a deletion', () => {
    const base = PACKAGES.map(p =>
      p.name === '@lexical/list' ? {...p, dir: 'packages/lexical-lists'} : p,
    );
    const result = checkCoverage({
      basePackages: base,
      changes: [
        {
          file: 'packages/lexical-list/src/index.ts',
          previous: 'packages/lexical-lists/src/index.ts',
          status: 'R100',
        },
      ],
      changesets: [],
      manifestFields: () => [],
      packages: PACKAGES,
    });
    expect(result.removed).toEqual([]);
    expect([...result.required.keys()]).toEqual(['@lexical/list']);
  });

  it('fails with the changeset to add when shipped code changes', () => {
    const result = checkCoverage({
      changes: parseNameStatus(
        [
          'M\tpackages/lexical-list/src/LexicalListNode.ts',
          'M\tpackages/lexical-list/src/__tests__/unit/List.test.ts',
          'M\tpackages/lexical-playground/src/App.tsx',
        ].join('\n'),
      ),
      changesets: [],
      manifestFields: () => [],
      packages: PACKAGES,
    });
    expect([...result.required.keys()]).toEqual(['@lexical/list']);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain(
      '@lexical/list: packages/lexical-list/src/LexicalListNode.ts',
    );
    expect(result.problems[0]).toContain("'@lexical/list': patch");
    expect(result.problems[0]).toContain(
      'pnpm run changeset:new -- --category fix --packages @lexical/list',
    );
    expect(result.problems[0]).toContain('skip-changeset');
  });

  it('passes when a changeset names every changed package', () => {
    const result = checkCoverage({
      changes: parseNameStatus(
        [
          'M\tpackages/lexical/src/LexicalNode.ts',
          'R090\tpackages/lexical-list/src/a.ts\tpackages/lexical-list/src/b.ts',
          'A\t.changeset/fix.md',
        ].join('\n'),
      ),
      changesets: [
        {file: '.changeset/fix.md', releases: {'@lexical/list': 'patch'}},
        {file: '.changeset/core.md', releases: {lexical: 'patch'}},
      ],
      manifestFields: () => [],
      packages: PACKAGES,
    });
    expect(result.problems).toEqual([]);
  });

  it('ignores package.json changes that consumers do not see', () => {
    const result = checkCoverage({
      changes: [{file: 'packages/lexical-list/package.json', status: 'M'}],
      changesets: [],
      manifestFields: () => [],
      packages: PACKAGES,
    });
    expect(result.problems).toEqual([]);
  });
});

describe('add-changeset link', () => {
  it('derives the summary, category and file name from the PR title', () => {
    expect(
      fromPullRequestTitle(
        '[lexical-list][lexical] Bug Fix: keep the caret after a decorator (#9300)',
      ),
    ).toEqual({
      category: 'fix',
      slug: 'keep-the-caret-after-a-decorator',
      summary: 'Keep the caret after a decorator',
    });
    expect(fromPullRequestTitle('[*] Breaking change: Remove `x`')).toEqual({
      category: 'breaking',
      slug: 'remove-x',
      summary: 'Remove `x`',
    });
    expect(fromPullRequestTitle('')).toMatchObject({slug: 'changeset'});
  });

  it('builds a prefilled GitHub new-file URL on the head branch', () => {
    const value = changesetTemplate(['@lexical/list'], 'fix', 'Keep & go');
    expect(value).toBe("---\n'@lexical/list': patch\n---\n\n[fix] Keep & go\n");
    const url = newChangesetUrl({
      filename: '.changeset/keep-go.md',
      ref: 'someone/fix list',
      repository: 'someone/lexical',
      value,
    });
    expect(url).toBe(
      'https://github.com/someone/lexical/new/someone/fix%20list?filename=.changeset%2Fkeep-go.md&value=' +
        encodeURIComponent(value),
    );
    expect(new URL(url).searchParams.get('value')).toBe(value);
    expect(
      validate(changesetTemplate(['lexical'], 'breaking', 'Remove x')).errors,
    ).toEqual([]);
  });
});

describe('.changeset/config.json', () => {
  it('matches changesets-style globs with negation', () => {
    expect(
      matchPackages(
        ['lexical', '@lexical/list', '@lexical/website', '@lexical/dev-a'],
        ['lexical', '@lexical/*', '!@lexical/website', '!@lexical/dev-*'],
      ),
    ).toEqual(['lexical', '@lexical/list']);
  });

  it('reports packages missing from the fixed group or ignore list', () => {
    expect(
      configProblems(
        {fixed: [['lexical', '@lexical/list']], ignore: []},
        PACKAGES,
      ),
    ).toEqual([
      expect.stringMatching(/missing from the "fixed" group: @lexical\/table/),
      expect.stringMatching(/missing from "ignore": lexical-playground/),
    ]);
  });

  it('covers every package in this repository', () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(ROOT, '.changeset', 'config.json'), 'utf8'),
    );
    expect(configProblems(config, readPackages(ROOT))).toEqual([]);
  });
});

describe('changeset:new', () => {
  it('writes files the check accepts, with TODOs for required sections', () => {
    const fix = formatChangeset({
      category: 'fix',
      contributors: ['@someone'],
      packages: ['lexical', '@lexical/list'],
      pr: 9300,
      summary: 'Keep the caret',
    });
    expect(fix).toBe(
      "---\n'lexical': patch\n'@lexical/list': patch\n---\n\n[fix] Keep the caret\n@someone\nPR: #9300\n",
    );
    expect(validate(fix)).toEqual({errors: [], warnings: []});

    const breaking = formatChangeset({
      category: 'breaking',
      packages: ['lexical'],
      sections: {detect: '`.oldMethod(`'},
      summary: 'Remove `oldMethod`',
    });
    expect(breaking).toBe(
      "---\n'lexical': minor\n---\n\n[breaking] Remove `oldMethod`\n\nMigration: TODO\n\nDetect: `.oldMethod(`\n",
    );
    expect(validate(breaking).errors).toEqual([
      expect.stringMatching(/"Migration:" paragraph is still a placeholder/),
    ]);
    expect(slugify('Remove `oldMethod` from the [x] API!')).toBe(
      'remove-oldmethod-from-the-x-api',
    );
  });

  it('writes the file and refuses bad input', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexical-new-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const args = ['--dir', dir, '--packages', '@lexical/table'];
      expect(
        newChangeset([
          ...args,
          '--category',
          'deprecation',
          '--summary',
          'Deprecate `$x`',
          '--replacement',
          '`$y`.',
          '--removal',
          'not scheduled',
        ]),
      ).toBe(0);
      const written = fs.readFileSync(path.join(dir, 'deprecate-x.md'), 'utf8');
      expect(validate(written).errors).toEqual([]);
      expect(newChangeset([...args, '--summary', 'No category'])).toBe(2);
      expect(
        newChangeset([
          '--dir',
          dir,
          '--packages',
          'lexical-playground',
          '--category',
          'fix',
          '--summary',
          'Private',
        ]),
      ).toBe(1);
      expect(error.mock.calls.at(-1)?.[0]).toMatch(/is private/);
    } finally {
      log.mockRestore();
      error.mockRestore();
      fs.rmSync(dir, {force: true, recursive: true});
    }
  });
});
