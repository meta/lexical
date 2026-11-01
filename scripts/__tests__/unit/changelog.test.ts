/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  compareVersions,
  insertVersionBlock,
  parseChangelog,
  parseEntryHead,
  rangeToJSON,
  renderAllChanges,
  renderRange,
  renderVersionBlock,
  selectRange,
} from '../../changesets/changelog.mjs';
import {isRemoval} from '../../changesets/entry.mjs';
import {main as range} from '../../changesets/range.mjs';
import {
  commitsSince,
  main as release,
  nextVersion,
  patchGuard,
  previousRelease,
  renderGuard,
  renderUnreleased,
} from '../../changesets/release.mjs';
import {main as notes, releaseNotes} from '../../changesets/release-notes.mjs';
import {readPending, resolveOrigin, ROOT} from '../../changesets/repo.mjs';

const FIXTURES = path.join(__dirname, 'fixtures', 'changesets');

const BLOCK = renderVersionBlock({
  date: '2026-10-30',
  entries: [
    {
      category: 'fix',
      contributors: ['@someone'],
      details: '',
      packages: ['@lexical/list'],
      pr: 9400,
      summary: 'Keep the list marker style when a list item is split',
    },
    {
      category: 'breaking',
      contributors: ['Some Name', '@someone'],
      details: [
        'Migration: use `$getCommonAncestor`.',
        '',
        '```ts',
        'const ancestor = $getCommonAncestor(a, b);',
        '```',
      ].join('\n'),
      packages: ['@lexical/html', 'lexical'],
      pr: 9401,
      summary: 'Remove `LexicalNode.getCommonAncestor`',
    },
  ],
  version: '0.53.0',
});

const OLD_CHANGELOG = `# Changelog

Preamble.

## v0.52.0 (2026-09-27)

### Breaking changes

- **lexical**: \`LexicalNode.getCommonAncestor\` removed ([#9238](https://github.com/meta/lexical/pull/9238))

  Migration: use \`$getCommonAncestor\`.

### Deprecations

- **@lexical/mdast**: \`MdastImportExtension\` deprecated ([#9198](https://github.com/meta/lexical/pull/9198))

  Replacement: \`MdastExtension\`.

### All changes

- lexical Bug Fix Track explicit Shift state for iOS line breaks (#9242) Bob Ippolito
- v0.51.0 (#9178) Bob Ippolito

## v0.51.1 (2026-09-20)

- lexical-list Bug Fix Something (#9190) Someone

## 0.4.1 (September 5, 2022)

- Fix a thing
`;

describe('renderVersionBlock', () => {
  it('renders categories in order with packages, PR links and contributors', () => {
    expect(BLOCK).toBe(
      [
        '## v0.53.0 (2026-10-30)',
        '',
        '### Breaking changes',
        '',
        '- **lexical, @lexical/html**: Remove `LexicalNode.getCommonAncestor` ([#9401](https://github.com/meta/lexical/pull/9401))',
        '',
        '  Migration: use `$getCommonAncestor`.',
        '',
        '  ```ts',
        '  const ancestor = $getCommonAncestor(a, b);',
        '  ```',
        '',
        '### Fixes',
        '',
        '- **@lexical/list**: Keep the list marker style when a list item is split ([#9400](https://github.com/meta/lexical/pull/9400))',
        '',
        '### Contributors',
        '',
        '@someone, Some Name',
        '',
      ].join('\n'),
    );
  });

  it('keeps special characters that the old changelog script stripped', () => {
    const block = renderVersionBlock({
      date: '2026-10-30',
      entries: [
        {
          category: 'feature',
          contributors: [],
          details: '',
          packages: ['@lexical/list'],
          pr: null,
          summary: '`$insertList` accepts [options] & more',
        },
      ],
      version: '0.53.0',
    });
    expect(block).toContain(
      '- **@lexical/list**: `$insertList` accepts [options] & more\n',
    );
  });

  it('says so when a release has no entries', () => {
    expect(
      renderVersionBlock({date: '2026-10-30', entries: [], version: '0.52.1'}),
    ).toBe(
      '## v0.52.1 (2026-10-30)\n\nNo user-facing changes were recorded for this release.\n',
    );
  });
});

describe('behavior changes', () => {
  const block = renderVersionBlock({
    date: '2026-10-30',
    entries: [
      {
        category: 'fix',
        contributors: [],
        details: '',
        packages: ['lexical'],
        pr: 1,
        summary: 'Plain fix',
      },
      {
        category: 'fix',
        contributors: [],
        details: 'Verify: HTML export snapshots.',
        packages: ['@lexical/html'],
        pr: 2,
        summary: 'Export a terminating `<br>`',
      },
      {
        category: 'breaking',
        contributors: [],
        details: 'Migration: x.\n\nDetect: `y`.\n\nVerify: z.',
        packages: ['lexical'],
        pr: 3,
        summary: 'Remove `y`',
      },
      {
        category: 'deprecation',
        contributors: [],
        details: 'Replacement: `b`.\n\nRemoval: not scheduled.',
        packages: ['lexical'],
        pr: 4,
        summary: 'Deprecate `a`',
      },
    ],
    version: '0.53.0',
  });

  it('lists non-breaking entries with Verify right after breaking changes', () => {
    expect(block.split('\n').filter(l => l.startsWith('### '))).toEqual([
      '### Breaking changes',
      '### Behavior changes',
      '### Deprecations',
      '### Fixes',
    ]);
    expect(block).toContain(
      '### Behavior changes\n\n- **@lexical/html**: Export a terminating `<br>` ([#2](https://github.com/meta/lexical/pull/2))\n\n  Verify: HTML export snapshots.\n\n### Deprecations',
    );
    expect(block).toContain('### Fixes\n\n- **lexical**: Plain fix');
  });

  it('keeps behavior changes in --breaking ranges and marks them in JSON', () => {
    const versions = parseChangelog(insertVersionBlock(OLD_CHANGELOG, block));
    expect(versions[0].sections.map(s => s.kind)).toEqual([
      'breaking',
      'behavior',
      'deprecation',
      'fix',
    ]);
    const selected = selectRange(versions, {
      breakingOnly: true,
      from: '0.52.0',
    });
    expect(selected[0].sections.map(s => s.kind)).toEqual([
      'breaking',
      'behavior',
      'deprecation',
    ]);
    const json = rangeToJSON(selected);
    expect(
      json[0].sections.map(s => s.entries.map(e => [e.pr, e.behavior])),
    ).toEqual([[[3, false]], [[2, true]], [[4, false]]]);
    expect(json[0].sections[1].entries[0].sections).toEqual({
      verify: 'HTML export snapshots.',
    });
  });
});

describe('insertVersionBlock', () => {
  it('inserts above the newest version and keeps the preamble', () => {
    const out = insertVersionBlock(OLD_CHANGELOG, BLOCK);
    expect(out.startsWith('# Changelog\n\nPreamble.\n\n## v0.53.0')).toBe(true);
    expect(out).toContain('@someone, Some Name\n\n## v0.52.0 (2026-09-27)');
    expect(parseChangelog(out).map(v => v.version)).toEqual([
      '0.53.0',
      '0.52.0',
      '0.51.1',
      '0.4.1',
    ]);
  });

  it('handles an empty changelog', () => {
    expect(insertVersionBlock('', BLOCK)).toBe(BLOCK);
  });
});

describe('parseChangelog', () => {
  it('round-trips a rendered block', () => {
    const [version] = parseChangelog(BLOCK);
    expect(version.version).toBe('0.53.0');
    expect(version.date).toBe('2026-10-30');
    expect(version.sections.map(s => s.kind)).toEqual([
      'breaking',
      'fix',
      'contributors',
    ]);
    const [breaking] = version.sections[0].entries;
    expect(breaking.packages).toEqual(['lexical', '@lexical/html']);
    expect(breaking.pr).toBe(9401);
    expect(breaking.summary).toBe('Remove `LexicalNode.getCommonAncestor`');
    expect(breaking.sections.migration).toBe(
      'use `$getCommonAncestor`.\n\n```ts\nconst ancestor = $getCommonAncestor(a, b);\n```',
    );
  });

  it('parses blocks without sections and old heading shapes', () => {
    const versions = parseChangelog(OLD_CHANGELOG);
    expect(versions[1].sections).toHaveLength(1);
    expect(versions[1].sections[0].kind).toBe('all');
    expect(versions[1].sections[0].entries[0].pr).toBe(9190);
    expect(versions[2]).toMatchObject({
      date: 'September 5, 2022',
      version: '0.4.1',
    });
  });

  it('parses flat lines and new bullets', () => {
    expect(
      parseEntryHead(
        'lexical Bug Fix Track explicit Shift state (#9242) Bob Ippolito',
      ),
    ).toEqual({
      packages: [],
      pr: 9242,
      summary: 'lexical Bug Fix Track explicit Shift state Bob Ippolito',
    });
    expect(
      parseEntryHead(
        '**lexical, @lexical/html**: Summary (with parens) ([#1](https://github.com/meta/lexical/pull/1))',
      ),
    ).toEqual({
      packages: ['lexical', '@lexical/html'],
      pr: 1,
      summary: 'Summary (with parens)',
    });
  });

  it('parses the repository CHANGELOG.md', () => {
    const versions = parseChangelog(
      fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'),
    );
    expect(versions.length).toBeGreaterThan(100);
    const counts = {behavior: 0, breaking: 0, deprecation: 0};
    for (const v of selectRange(versions, {from: '0.22.0', to: '0.52.0'})) {
      // Every version from v0.23.0 has curated sections over the commits.
      expect(v.sections.map(s => s.title).at(-1)).toBe('All changes');
      for (const s of v.sections) {
        for (const entry of s.entries) {
          const label = `v${v.version} ${entry.summary}`;
          if (s.kind === 'breaking') {
            counts.breaking++;
            expect(entry.sections.detect, label).toBeTruthy();
            expect(entry.sections.migration, label).toBeTruthy();
          } else if (s.kind === 'behavior') {
            counts.behavior++;
            expect(entry.sections.verify, label).toBeTruthy();
          } else if (s.kind === 'deprecation') {
            counts.deprecation++;
            expect(entry.sections.replacement, label).toBeTruthy();
            expect(isRemoval(entry.sections.removal || ''), label).toBe(true);
          } else {
            continue;
          }
          expect(entry.pr, label).not.toBeNull();
        }
      }
    }
    expect(counts).toEqual({behavior: 43, breaking: 35, deprecation: 29});
  });
});

describe('selectRange', () => {
  const versions = parseChangelog(OLD_CHANGELOG);

  it('selects (from, to] oldest first', () => {
    expect(selectRange(versions, {from: '0.4.1'}).map(v => v.version)).toEqual([
      '0.51.1',
      '0.52.0',
    ]);
    expect(
      selectRange(versions, {from: '0.0.0', to: '0.51.1'}).map(v => v.version),
    ).toEqual(['0.4.1', '0.51.1']);
  });

  it('keeps only breaking changes and deprecations with breakingOnly', () => {
    const selected = selectRange(versions, {breakingOnly: true, from: '0.4.1'});
    expect(selected.map(v => v.version)).toEqual(['0.52.0']);
    expect(renderRange(selected)).toBe(
      [
        '## v0.52.0 (2026-09-27)',
        '',
        '### Breaking changes',
        '',
        '- **lexical**: `LexicalNode.getCommonAncestor` removed ([#9238](https://github.com/meta/lexical/pull/9238))',
        '',
        '  Migration: use `$getCommonAncestor`.',
        '',
        '### Deprecations',
        '',
        '- **@lexical/mdast**: `MdastImportExtension` deprecated ([#9198](https://github.com/meta/lexical/pull/9198))',
        '',
        '  Replacement: `MdastExtension`.',
      ].join('\n'),
    );
  });

  it('produces JSON with structured entries', () => {
    const [v] = rangeToJSON(
      selectRange(versions, {breakingOnly: true, from: '0.51.1'}),
    );
    expect(v.version).toBe('0.52.0');
    expect(v.sections[0]).toMatchObject({
      entries: [
        {
          packages: ['lexical'],
          pr: 9238,
          prUrl: 'https://github.com/meta/lexical/pull/9238',
          sections: {migration: 'use `$getCommonAncestor`.'},
          summary: '`LexicalNode.getCommonAncestor` removed',
        },
      ],
      kind: 'breaking',
    });
    expect(v.sections[1].entries[0].sections).toEqual({
      replacement: '`MdastExtension`.',
    });
  });

  it('compares versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.53.0-nightly.20261015.0', '0.53.0')).toBeLessThan(
      0,
    );
    expect(compareVersions('v0.52.0', '0.52.0')).toBe(0);
    expect(
      compareVersions('0.53.0-nightly.9.0', '0.53.0-nightly.10.0'),
    ).toBeLessThan(0);
    expect(compareVersions('0.53.0-next.1', '0.53.0-next.1.1')).toBeLessThan(0);
    expect(compareVersions('0.53.0-1', '0.53.0-alpha')).toBeLessThan(0);
  });
});

describe('release', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, {force: true, recursive: true});
    }
    vi.restoreAllMocks();
  });

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexical-changesets-'));
    dirs.push(dir);
    return dir;
  }

  function repo(changelog = OLD_CHANGELOG) {
    const dir = tempDir();
    const write = (file: string, contents: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), {recursive: true});
      fs.writeFileSync(path.join(dir, file), contents);
    };
    const run = (...args: string[]) =>
      execFileSync('git', args, {cwd: dir, encoding: 'utf8', stdio: 'pipe'});
    const commit = (subject: string) => {
      run('add', '-A');
      run('commit', '-q', '--allow-empty', '-m', subject);
    };
    const pkg = (name: string, extra = {}) =>
      JSON.stringify({name, version: '0.52.0', ...extra});
    write('package.json', pkg('lexical-monorepo', {private: true}));
    write('packages/lexical/package.json', pkg('lexical'));
    write('packages/lexical-list/package.json', pkg('@lexical/list'));
    write('packages/lexical-table/package.json', pkg('@lexical/table'));
    write('CHANGELOG.md', changelog);
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 'dev@example.com');
    run('config', 'user.name', 'Dev Example');
    commit('v0.52.0 (#9252)');
    run('tag', 'v0.52.0');
    return {commit, dir, run, write};
  }

  function repoWithChangesets(changelog = OLD_CHANGELOG) {
    const r = repo(changelog);
    r.commit('[lexical] Bug Fix: Keep <br> after a decorator (#9300)');
    const names = fs.readdirSync(path.join(FIXTURES, 'valid')).sort();
    for (const [i, name] of names.entries()) {
      r.write(
        `.changeset/${name}`,
        fs.readFileSync(path.join(FIXTURES, 'valid', name), 'utf8'),
      );
      r.commit(`Add ${name} (#${9400 + i})`);
    }
    r.write('.changeset/README.md', '# not a changeset\n');
    return r;
  }

  it('writes the version block, the commit list, and deletes the changesets', async () => {
    const {dir} = repoWithChangesets();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(
      await release([
        '--root',
        dir,
        '--version',
        '0.53.0',
        '--date',
        '2026-10-30',
      ]),
    ).toBe(0);
    const changelog = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
    const [v] = parseChangelog(changelog);
    expect(v.version).toBe('0.53.0');
    expect(v.sections.map(s => s.kind)).toEqual([
      'breaking',
      'deprecation',
      'fix',
      'contributors',
      'all',
    ]);
    expect(v.sections[0].entries[0].pr).toBe(9402);
    expect(v.sections[3].body).toBe('Dev Example, @contributor');
    // Every commit since v0.52.0, newest included, the release commit not.
    expect(v.sections[4].body).toBe(
      [
        '- Add remove-get-common-ancestor.md ([#9402](https://github.com/meta/lexical/pull/9402)) Dev Example',
        '- Add list-marker-style.md ([#9401](https://github.com/meta/lexical/pull/9401)) Dev Example',
        '- Add deprecate-table-selection.md ([#9400](https://github.com/meta/lexical/pull/9400)) Dev Example',
        '- [lexical] Bug Fix: Keep \\<br> after a decorator ([#9300](https://github.com/meta/lexical/pull/9300)) Dev Example',
      ].join('\n'),
    );
    expect(fs.readdirSync(path.join(dir, '.changeset'))).toEqual(['README.md']);
    expect(releaseNotes(changelog, 'v0.53.0')).toBe(v.body);
  });

  it('escapes backslashes and angle brackets in commit subjects', () => {
    expect(
      renderAllChanges([
        {author: 'Dev Example', subject: 'Fix C:\\path and <br> (#9300)'},
      ]),
    ).toBe(
      '- Fix C:\\\\path and \\<br> ([#9300](https://github.com/meta/lexical/pull/9300)) Dev Example',
    );
  });

  it('refuses while the previous release is missing from CHANGELOG.md', async () => {
    const {dir} = repoWithChangesets(
      '# Changelog\n\n## v0.51.0 (2026-09-17)\n\n- Old\n',
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await release(['--root', dir, '--version', '0.53.0'])).toBe(1);
    expect(error.mock.calls[0][0]).toMatch(
      /no v0\.52\.0 section, so the v0\.52\.0 release pull request is not merged yet/,
    );
    expect(fs.readdirSync(path.join(dir, '.changeset'))).toHaveLength(4);
  });

  it('refuses to add a version that is already there', () => {
    expect(renderGuard(OLD_CHANGELOG, '0.52.0', '0.51.1')).toMatch(
      /already has a v0\.52\.0 section/,
    );
    expect(renderGuard(OLD_CHANGELOG, '0.53.0', '0.52.0')).toBeNull();
    expect(renderGuard(OLD_CHANGELOG, '0.53.0', null)).toBeNull();
  });

  it('refuses a patch release while a breaking change is pending', async () => {
    const {dir} = repoWithChangesets();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await release(['--root', dir, '--version', '0.52.1'])).toBe(1);
    expect(error.mock.calls[0][0]).toMatch(
      /Refusing to release 0\.52\.1 as a patch/,
    );
  });

  it('skips prereleases and renders their changes as Unreleased', async () => {
    const {dir} = repoWithChangesets();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(
      await release(['--root', dir, '--version', '0.52.1-nightly.20261015.0']),
    ).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8')).toBe(
      OLD_CHANGELOG,
    );
    const unreleased = await renderUnreleased(dir, '0.52.1-nightly.20261015.0');
    expect(unreleased.split('\n').slice(0, 5)).toEqual([
      '## Unreleased',
      '',
      'Merged after the latest stable release and included in 0.52.1-nightly.20261015.0. These entries move into a version section when the next stable release is cut.',
      '',
      '### Breaking changes',
    ]);
    // The Unreleased block is not mistaken for a version.
    expect(
      parseChangelog(insertVersionBlock(OLD_CHANGELOG, unreleased))[0].version,
    ).toBe('0.52.0');
  });

  it('finds the previous stable release from tags and LATEST_RELEASE', () => {
    const {dir, run} = repo();
    run('tag', 'v0.52.1-nightly.20261015.0');
    expect(previousRelease(dir, '0.53.0', undefined)).toBe('0.52.0');
    expect(previousRelease(dir, '0.53.0', 'v0.52.5')).toBe('0.52.5');
    expect(previousRelease(dir, '0.52.0', undefined)).toBeNull();
    expect(commitsSince(dir, '0.52.0')).toEqual([]);
  });

  it('picks the next minor for breaking changes and the next patch otherwise', () => {
    const pending = readPending(path.join(FIXTURES, 'valid'), ROOT);
    expect(nextVersion('0.52.0', pending)).toBe('0.53.0');
    expect(
      nextVersion(
        '0.52.0',
        pending.filter(c => c.entry.category !== 'breaking'),
      ),
    ).toBe('0.52.1');
    expect(patchGuard('0.53.0', pending)).toBeNull();
    expect(patchGuard('0.52.1', pending)).toMatch(/need a minor release/);
  });

  describe('resolveOrigin', () => {
    it('reads the PR from the squash subject, following renames', async () => {
      const {dir, write, commit, run} = repo();
      write('.changeset/old.md', 'x');
      commit('Add a changeset (#88)');
      run('mv', '.changeset/old.md', '.changeset/new.md');
      commit('Rename it');
      expect(await resolveOrigin(dir, '.changeset/new.md')).toEqual({
        author: 'Dev Example',
        pr: 88,
      });
    });

    it('prefers a PR: line and does not credit the committer then', async () => {
      const {dir, write, commit} = repo();
      write('.changeset/a.md', 'x');
      commit('Maintainer follow-up (#90)');
      expect(
        await resolveOrigin(dir, '.changeset/a.md', {prOverride: 12}),
      ).toEqual({author: null, pr: 12});
    });

    it('falls back to the first-parent merge commit', async () => {
      const {dir, write, commit, run} = repo();
      run('checkout', '-q', '-b', 'feature');
      write('.changeset/a.md', 'x');
      commit('Add a changeset');
      run('checkout', '-q', 'main');
      commit('Something else on main (#91)');
      run(
        'merge',
        '-q',
        '--no-ff',
        '-m',
        'Merge pull request #77 from someone/feature',
        'feature',
      );
      expect(await resolveOrigin(dir, '.changeset/a.md')).toEqual({
        author: 'Dev Example',
        pr: 77,
      });
    });

    it('asks the GitHub API when git has no PR, and skips bots', async () => {
      const {dir, write, commit} = repo();
      write('.changeset/a.md', 'x');
      commit('Add a changeset');
      write('.changeset/b.md', 'x');
      commit('Add another changeset (#93)');
      const routes: string[] = [];
      const fetchImpl = (async (url: string) => {
        routes.push(url.replace(/.*\/repos\/[^/]+\/[^/]+\//, ''));
        const body = url.includes('/commits/')
          ? [{merged_at: '2026-10-01', number: 55, user: {login: 'octo'}}]
          : {number: 93, user: {login: 'renovate[bot]'}};
        return {json: async () => body, ok: true};
      }) as unknown as typeof fetch;
      const options = {fetchImpl, repository: 'meta/lexical', token: 't'};
      expect(await resolveOrigin(dir, '.changeset/a.md', options)).toEqual({
        author: '@octo',
        pr: 55,
      });
      expect(await resolveOrigin(dir, '.changeset/b.md', options)).toEqual({
        author: null,
        pr: 93,
      });
      expect(routes[0]).toMatch(/^commits\/[0-9a-f]{40}\/pulls$/);
      expect(routes[1]).toBe('pulls/93');
    });

    it('works without git history', async () => {
      const dir = tempDir();
      expect(await resolveOrigin(dir, '.changeset/a.md')).toEqual({
        author: null,
        pr: null,
      });
    });
  });
});

describe('command line', () => {
  it('range rejects bad input with usage and exit code 2', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(range([])).toBe(2);
    expect(range(['--from', 'latest'])).toBe(2);
    expect(range(['--from', '0.50.0', '--to', '0.49.0'])).toBe(2);
    expect(range(['--from', '0.50.0', '--nope'])).toBe(2);
    expect(range(['--from', '0.50.0', 'stray'])).toBe(2);
    expect(notes(['--version', 'next'])).toBe(2);
    expect(error.mock.calls.every(c => /usage:/.test(c[0]))).toBe(true);
    vi.restoreAllMocks();
  });

  it('range names versions that --breaking cannot show', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexical-range-'));
    try {
      const file = path.join(dir, 'CHANGELOG.md');
      fs.writeFileSync(file, OLD_CHANGELOG);
      const out: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
        out.push(String(chunk));
        return true;
      });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(
        range(['--', '--from', '0.4.1', '--breaking', '--changelog', file]),
      ).toBe(0);
      expect(error.mock.calls[0][0]).toMatch(
        /^Note: v0\.51\.1 has no curated sections/,
      );
      expect(out.join('')).toMatch(/^## v0\.52\.0 \(2026-09-27\)/);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(dir, {force: true, recursive: true});
    }
  });

  it('runs through a symlink', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexical-link-'));
    try {
      const link = path.join(dir, 'range.mjs');
      fs.symlinkSync(path.join(ROOT, 'scripts/changesets/range.mjs'), link);
      const out = execFileSync(
        process.execPath,
        [link, '--from', '0.51.0', '--to', '0.51.0'],
        {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']},
      );
      expect(out).toBe('');
    } catch (error) {
      // --to equal to --from is a usage error: exit 2 proves main() ran.
      expect((error as {status: number}).status).toBe(2);
    } finally {
      fs.rmSync(dir, {force: true, recursive: true});
    }
  });
});
