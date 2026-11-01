# Changesets

A changeset is required for every user-facing change: anything that changes
what a published package does for people who use it. It is a small Markdown
file in this directory that becomes the change's entry in
[CHANGELOG.md](../CHANGELOG.md) at the next release. The changelog is how
people (and tools such as Renovate, Dependabot, and coding agents) find out
what changed between the version they have and the version they want, so
each entry is written for someone who uses Lexical, not for its maintainers.

Create one with `pnpm run changeset:new`, or write the file by hand:

```sh
pnpm run changeset:new -- --category fix --packages @lexical/list \
  --summary "Keep the list marker style when a list item is split"
```

```md
---
'@lexical/list': patch
---

[fix] Keep the list marker style when a list item is split
```

## Format

The frontmatter lists every published package the change affects, with a
bump:

- `minor` for `[breaking]` changes;
- `patch` for everything else.

Lexical is `0.x`, so `major` is never used (it would publish `1.0.0`). All
packages are released together at one version; the bump only decides
whether the next release has to be a minor.

The first line of the body is `[category] summary`: one line, in the present
tense, describing the change from the user's side. Do not add the pull
request number; the release takes it from git. Categories, in the order the
changelog shows them:

| Category      | Use for                                                      |
| ------------- | ------------------------------------------------------------ |
| `breaking`    | Code that worked before has to change (API, types, behavior) |
| `deprecation` | An API still works but has a replacement and will go away    |
| `feature`     | A new capability                                             |
| `fix`         | A bug fix                                                    |
| `perf`        | A performance improvement                                    |
| `docs`        | Documentation shipped in a package (README, JSDoc)           |
| `chore`       | Anything else worth telling users (shown under "Other")      |

`feat`, `bug`, `bugfix`, `deprecated`, `performance` and `refactor` are
accepted as aliases.

A line of `@handles` directly under the summary credits contributors; when it
is missing, the release credits the author of the pull request that added
the changeset. When a changeset is added in a different pull request than
the change it describes (for example by a maintainer, after the fact), add a
`PR: #123` line under the summary so the entry links the right pull request.

More paragraphs may follow, separated by blank lines. They are copied into
the changelog verbatim, so code blocks and lists are fine; Markdown headings
are not, because they would break the changelog's structure.

### Breaking changes

A `breaking` entry must have a `Migration:` paragraph that tells callers what
to change, and a `Detect:` paragraph naming what identifies affected code
(usually just the symbol, import or CSS class). It may also have `Codemod:`
(a codemod, or why there is none) and `Verify:` (what to test).

````md
---
'lexical': minor
---

[breaking] Remove `LexicalNode.getCommonAncestor`

Migration: use `$getCommonAncestor` from `lexical`.

```ts
// Before
const ancestor = a.getCommonAncestor(b);
// After
const ancestor = $getCommonAncestor(a, b)?.commonAncestor ?? null;
```

Detect: calls to `.getCommonAncestor(` on nodes.

Codemod: none; the old method replaced non-element arguments with their
parents first, so each call site needs review.
````

### Deprecations

A `deprecation` entry must name the replacement in a `Replacement:`
paragraph (or say `Replacement: none` and why), and say when removal is
planned in a `Removal:` paragraph that starts with a version (`v0.60.0`),
`no earlier than v0.60.0`, or `not scheduled`.

```md
---
'@lexical/table': patch
---

[deprecation] Deprecate `$createTableSelection`

Replacement: `$createTableSelectionFrom`.

Removal: no earlier than v0.60.0.
```

### Behavior changes

A change that needs no code change but changes observable behavior or output
(an exported HTML or JSON shape, the DOM, an editing behavior, timing) is
not `breaking`, but people upgrading should still check it. Give it its usual
category (usually `fix`) and add a `Verify:` paragraph saying what to test:

```md
---
'lexical': patch
'@lexical/html': patch
---

[fix] Export a terminating `<br>` for a trailing line break

Verify: HTML export snapshots of blocks that end with a line break.
```

Any entry other than `breaking` that has a `Verify:` paragraph is listed under
**Behavior changes**, right after the breaking changes. Reviewers add
`Verify:` when a fix changes observable output.

## When a changeset is needed

Every user-facing change needs one. Tests, the website, the playground,
examples and tooling need none.

CI checks this: when a pull request changes a published package's `src/`
(tests, benchmarks and mocks excluded), its Flow types, or the
consumer-facing fields of its `package.json`, and no changeset in the pull
request names that package, the Changesets workflow reports the file to add.
Deleting a published package needs a `[breaking]` changeset that names it.
For now the workflow only reports (in the job summary and as an annotation)
and does not fail; a malformed changeset always fails `pnpm run ci-check`.

When a change has no effect on people who use Lexical, a maintainer can add
the `skip-changeset` label to the pull request instead. Maintainers can also
add the changeset on behalf of a contributor.

`pnpm run check-changesets` validates the pending changesets locally, and
`pnpm run changelog` previews the CHANGELOG.md block they would produce.

## Reading the changelog

Every release adds a `## vX.Y.Z (date)` section to CHANGELOG.md, with the
curated sections above and an `### All changes` list of every commit. The
file also ships in the `lexical` package, so an app can read the history
of the version it has installed at `node_modules/lexical/CHANGELOG.md`. To
print only the part between two versions, run this in a clone of the
repository:

```sh
pnpm run changelog:range -- --from 0.52.0 --breaking
# or against an app's installed copy:
node scripts/changesets/range.mjs --changelog /path/to/app/node_modules/lexical/CHANGELOG.md --from 0.52.0
```
