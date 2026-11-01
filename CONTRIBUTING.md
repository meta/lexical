# Contributing to lexical

We want to make contributing to this project as easy and transparent as
possible.

## Pull Requests

We actively welcome your pull requests.

This project uses [pnpm](https://pnpm.io/) as its package manager. If you don't have it installed:

```bash
npm install -g pnpm
# or use corepack (works with all Node.js versions)
npx corepack@latest enable
```

1. Fork the repo and create your branch from `main`.
2. Run `pnpm install` to install dependencies.
3. If you've added code that should be tested, add tests.
4. If you've changed APIs, update the documentation.
5. If your change is user-facing, add a [changeset](#changesets).
6. Ensure the test suite passes.
7. Make sure your code lints.
8. If you haven't already, complete the Contributor License Agreement ("CLA").

Note that the local server needs to be running in order to run the e2e tests.

- `pnpm run start`
- `pnpm run test-e2e-chromium` (to run only chromium e2e tests)

`pnpm run start` will start both the dev server and collab server. If you don't need collab, use `pnpm run dev` to start just the dev server. To try the experimental `@lexical/y` collaboration (`?isCollab=true&useCollabY=true`), use `pnpm run start:y`, which starts the dev server and its Yjs 14 collab server (`pnpm run collab:y`).

If you're contributing to the website or documentation, you can run docusaurus
with:

- `pnpm run start:website`

A full build of the website can be done with:

- `pnpm -C packages/lexical-website run build`

## Changesets

A changeset is required for every user-facing change: anything that changes
what a published package does for people who use it. It is a short Markdown
file in `.changeset/` that becomes the change's entry in
[CHANGELOG.md](./CHANGELOG.md) when the next version is released. The
changelog is how people upgrading Lexical, and tools such as Renovate,
Dependabot, and coding agents, learn what changed, so write the entry for
someone who uses Lexical.

Run `pnpm run changeset:new -- --category fix --packages @lexical/list --summary "..."`,
or create the file by hand:

```md
---
'@lexical/list': patch
---

[fix] Keep the list marker style when a list item is split
```

- The first line is `[category] one-line summary`. Categories: `breaking`,
  `deprecation`, `feature`, `fix`, `perf`, `docs`, `chore`.
- Use `minor` for `[breaking]` and `patch` for everything else. Lexical is
  `0.x`, so breaking changes ship in minor releases.
- Do not add the pull request number; the release takes it from git. A
  maintainer adding a changeset in a later pull request writes a
  `PR: #123` line under the summary instead.
- A `[breaking]` entry must include `Migration:` (what to change) and
  `Detect:` (usually just the affected symbol, import or CSS class), and may
  include `Codemod:` and `Verify:`:

  ````md
  ---
  'lexical': minor
  ---

  [breaking] Remove `LexicalNode.getCommonAncestor`

  Migration: use `$getCommonAncestor` from `lexical`.

  ```ts
  const ancestor = $getCommonAncestor(a, b)?.commonAncestor ?? null;
  ```

  Detect: calls to `.getCommonAncestor(` on nodes.
  ````

- A `[deprecation]` entry must name the replacement (`Replacement:`) and say
  when removal is planned (`Removal:` with a version, `no earlier than v0.NN`,
  or `not scheduled`).
- A fix that changes observable output or behavior (HTML, JSON, DOM, editing
  behavior) adds a `Verify:` paragraph saying what to test; it is then listed
  under "Behavior changes". Reviewers add it when it is missing.

When a pull request changes a published package's source without a
changeset, the Changesets workflow reports the file to add (for now as a
warning). Changes with no effect on people who use Lexical (tests, the
website, the playground, examples, tooling) need none; when CI asks for one
anyway, a maintainer can add the `skip-changeset` label. Maintainers can
also add the changeset for you.
`pnpm run check-changesets` validates changesets locally, and
`pnpm run changelog` previews the next CHANGELOG.md entry. The full format is
in [.changeset/README.md](./.changeset/README.md).

## Contributor License Agreement ("CLA")

In order to accept your pull request, we need you to submit a CLA. You only need
to do this once to work on any of Facebook's open source projects.

Complete your CLA here: <https://code.facebook.com/cla>

## Issues

We use GitHub issues to track public bugs. Please ensure your description is
clear and has sufficient instructions to be able to reproduce the issue.

Meta has a [bounty program](https://bugbounty.meta.com/) for the safe
disclosure of security bugs. In those cases, please go through the process
outlined on that page and do not file a public issue.

## License

By contributing to lexical, you agree that your contributions will be licensed
under the LICENSE file in the root directory of this source tree.
