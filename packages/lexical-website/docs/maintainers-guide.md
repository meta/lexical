# Maintainers' Guide

This is the grimoire of arcane knowledge covering the overall organization
of the Lexical monorepo, including its conventions, quirks, and
configurations.

## Monorepo Organization

### Workspaces

The top-level `package.json` uses
[pnpm workspaces](https://pnpm.io/workspaces) to
configure the monorepo. This mostly means that all packages share a
top-level `pnpm-lock.yaml` and `pnpm -C {package} run {command}` is often
used to run a command from a nested package's package.json.

### Private

Some packages in the monorepo do not get published to npm, for example:

* `packages/lexical-devtools` - browser extension for working with Lexical
  sites
* `packages/lexical-playground` - the
  [playground.lexical.dev](https://playground.lexical.dev/) demo site
* `packages/lexical-website` - the [lexical.dev](https://lexical.dev/)
  docusaurus website that you may even be reading right now
* `packages/lexical-test-utils` - `@lexical/test-utils`, private React
  testing helpers shared across package unit tests

Internal runtime code shared by more than one package lives in
`packages/lexical-internal` (`@lexical/internal`). Unlike the others above
it **is** published, but only so its source resolves through normal package
resolution (the `source` export condition used by linked-checkout
consumers); the compiled packages inline it, so it is never executed as a
separate runtime dependency. It is not a public API and has no semver
guarantees — see [Developing against a local Lexical
checkout](./maintainers-guide-link.md).

It is required that private packages, and any other package that should not
be published to npm, have a `"private": true` property in their `package.json`.
If you have an in-progress package that will eventually be public, but is
not ready for consumption, it should probably still be set to
`"private": true` otherwise the tooling will find it and publish it.

## Package naming conventions

### Overall

| Usage | Convention |
| -- | -- |
| Directory name | `packages/lexical-package-name` |
| Entrypoint | `packages/lexical-package-name/src/index.{ts,tsx}` |
| Flow types | `packages/lexical-package/flow/LexicalPackageName.js.flow` |
| package.json name | `@lexical/package-name` |
| Documentation | `packages/lexical-package-name/README.md` |
| Unit Tests | `packages/lexical-package-name/src/__tests__/unit/LexicalPackageName.test.{ts,tsx}` |
| dist (gitignore'd build product) | `packages/lexical-package-name/dist` |
| npm (gitignore'd prerelease product) | `packages/lexical-package-name/npm` |
| www entrypoint | `packages/lexical-package-name/LexicalPackageName.js` |

### Multiple module export (@lexical/react)

Instead of having a single module, some packages may have many modules
(currently only `@lexical/react`) that are each exported separately.
In that scenario, there should be no `index.ts` entrypoint file and every module
at the top-level should be an entrypoint. All entrypoints should be a
TypeScript file, not a subdirectory containing an index.ts file.

The [update-packages](#pnpm-run-update-packages) script will ensure that the
exports match the files on disk.

## Creating a new package

The first step in creating a new package is to create the workspace directory
and package.json file. The example we will use is the steps that were used
to create the `lexical-eslint-plugin`, which will be published to npm as
`@lexical/eslint-plugin`.

### Create the workspace

```bash
mkdir -p packages/lexical-eslint-plugin
```

Create the initial `package.json` file (you can base it on an existing package
or use the template below):

<details><summary>

`packages/lexical-eslint-plugin/package.json`
</summary>

```json
{
  "name": "@lexical/eslint-plugin",
  "description": "",
  "keywords": [
    "lexical",
    "editor"
  ],
  "version": "0.14.3",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/facebook/lexical.git",
    "directory": "packages/lexical-eslint-plugin"
  },
  "main": "LexicalEslintPlugin.js",
  "types": "index.d.ts",
  "bugs": {
    "url": "https://github.com/facebook/lexical/issues"
  },
  "homepage": "https://github.com/facebook/lexical#readme"
}
```
</details>

Some next steps for this package.json before moving on:

- Update the description
- Add appropriate keywords

### Create the initial source file

```
mkdir -p packages/lexical-eslint-plugin/src
code packages/lexical-eslint-plugin/src/index.ts
```

Here are some minimal examples of those files that you might start out with.
I've elided the license header, the eslint header/header fixer will help you
with that!

<details><summary>

`packages/lexical-eslint-plugin/src/index.ts`
</summary>

```typescript
import {name, version} from '../package.json';

const plugin = {
  meta: {name, version},
  rules: {},
};

export default plugin;
```
</details>

### Run update-packages to generate boilerplate docs & config

```
pnpm run update-packages
```

This will set up the tsconfig, flow, etc. configuration to recognize your
new module. It will also create an initial README.md using only the
description from the package.json.


### Create an initial unit test

```
mkdir -p packages/lexical-eslint-plugin/src/__tests__/unit
code packages/lexical-eslint-plugin/src/__tests__/unit/LexicalEslintPlugin.test.ts
```


<details><summary>

`packages/lexical-eslint-plugin/src/__tests__/unit/LexicalEslintPlugin.test.ts`
</summary>

```typescript
import plugin from '@lexical/eslint-plugin';

describe('LexicalEslintPlugin', () => {
  it('exports a plugin with meta and rules', () => {
    expect(Object.keys(plugin).sort()).toMatchObject(['meta', 'rules']);
  });
});
```
</details>


## Scripts for development

### pnpm run update-packages

This script runs: update-version, update-tsconfig, update-flowconfig,
create-docs, and create-www-stubs. This is safe to do at any time and will
ensure that package.json files are all at the correct versions, paths are
set up correctly for module resolution of all public exports, and that
various defaults are filled in.

These scripts can be run individually, but unless you're working on one
of these scripts you might as well run them all.

### pnpm run prepare-release

This runs `build-release` to produce all of the artifacts each public
package needs (the `dev`/`prod`/`node` ESM and CJS variants plus their
fork modules, `.d.ts` declarations, and `.flow` stubs under
`packages/<name>/dist/`), then runs the publish-time guard in
`scripts/npm/prepare-release.mjs` to confirm every path the package's
`exports`/`main`/`module`/`types` fields reference actually exists on
disk. The guard fails the build if e.g. you ran `pnpm run build` (dev
only) and then tried to publish — the `.prod.{js,mjs}` files would be
missing.

Each package is its own publish root: `packages/<name>/` IS the
publishable npm package after `build-release`. `pnpm publish` is run
directly from that directory by `scripts/npm/release.mjs` so pnpm's
automatic `workspace:*` rewriting and the `files` whitelist do the
right thing without an intermediate `npm/` copy step.

This will also update `scripts/error-codes/codes.json`, the mapping of
production error codes to error messages. It's imperative to commit the
result of this before tagging a release.

### pnpm run ci-check

Check flow, TypeScript, prettier and eslint for issues. A good command to run
after committing (which will auto-fix most prettier issues) and before pushing
a PR.

### pnpm run flow

Check the Flow types

### pnpm run tsc

Check the TypeScript types

### pnpm run tsc-extension

Check the TypeScript types of the lexical-devtools extension

### pnpm run test-unit

Run the unit tests

### pnpm run lint

Run eslint

## Scripts for release managers

### pnpm run extract-codes

This will run a build that also extracts the generated error codes.json file.

This should be done, at minimum, before each release, but not in any PR as
it would cause conflicts between serial numbers.

It's safe and probably advisable to do this more often, possibly any time a
branch is merged to main.

The codes.json file is also updated any time a release build is generated
as a failsafe to ensure that these codes are up to date in a release.
This command runs a development build to extract the codes which is much
faster as it is not doing any optimization/minification steps.

### pnpm run increment-version

Increment the monorepo version. The `-i` argument must be one of
`minor` | `patch` | `prerelease`.

The postversion script will:
- Create a local `${npm_package_version}__release` branch
- `pnpm run update-version` to update example and sub-package monorepo dependencies
- `pnpm install` to update the pnpm-lock.yaml
- `pnpm run update-packages` to update other generated config
- `pnpm run extract-codes` to extract the error codes
- `pnpm run update-changelog` to update the changelog (if it's not a prerelease)
- Create a version commit and tag from the branch

This is typically executed through the `version.yml` GitHub Workflow which
will also push the tag and branch.

### pnpm run changelog

Update the changelog from git history.

### pnpm run release

*Prerequisites:* all of the previous release manager scripts,
plus creating a tag in git, and likely other steps.

Runs prepare-release to do a full build and then uploads to npm.

### pnpm run setup-trusted-publishing

One-time (idempotent) helper to register every public package with
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers).
Re-run it whenever a new public package is added.

#### Prerequisites

- Node.js — whatever the repo's root `package.json#engines.node` says (currently `>=20.19.0`). Running with Node 24+ is recommended because that's what CI uses for publishes.
- pnpm — pinned by `package.json#packageManager` (currently `pnpm@11.24.0`). Activate with [corepack](https://nodejs.org/api/corepack.html) or install directly.
- npm CLI — **`npm ≥ 11.10`** (`npm i -g npm@latest`). The `npm trust` subcommand was added in npm 11; older versions will fail the preflight check.
- An authenticated npm session (`npm login --registry https://registry.npmjs.org`) on a publisher account that has **account-level 2FA enabled** and write access to every `@lexical/*` package.

#### Usage

Run in check-only mode first:

```bash
pnpm run setup-trusted-publishing
```

For each public package in the monorepo, it queries
`https://registry.npmjs.org` and reports whether the name is already
claimed. Packages that *don't* exist on the registry are listed; you
can re-run with `--bootstrap` to publish a deprecated
`0.0.0-bootstrap.0` placeholder under the `bootstrap` dist-tag so the
name can be claimed:

```bash
npm login --registry https://registry.npmjs.org
pnpm run setup-trusted-publishing --bootstrap
```

Once a package exists on the registry, you can configure trusted
publishing for it programmatically by adding `--setup-trust`. This
runs `npm trust github` under the hood (requires `npm` ≥ 11.10 and an
authenticated session with account-level 2FA on the publishing
account), and is idempotent — the script reads the existing trust
configuration for each package via a read-only registry call (no OTP)
and skips packages whose config already matches:

```bash
npm login --registry https://registry.npmjs.org
pnpm run setup-trusted-publishing --setup-trust
```

`npm trust github` is a write operation, so each package that *does*
need configuring will trigger a one-time-password / web-auth prompt.
On the first prompt npm prints a URL; open it in a browser, sign in,
and tick **"Skip two-factor authentication for the next 5 minutes"**.
Subsequent packages in the same run will then go through without
re-prompting. The script also inserts a small (~2 s) pause between
calls to stay under the registry's `E429` rate limit.

For full first-time setup of a brand-new monorepo, combine both flags:

```bash
pnpm run setup-trusted-publishing --bootstrap --setup-trust
```

When adding a **single** new package to an existing monorepo — the common
case going forward — pass its name so the run only touches that package
instead of re-checking all 30+ already-configured ones (which just prints a
wall of `CONFLICT` lines). The name can be the full npm name or the unscoped
short name, and `--package` / positional args are interchangeable and
repeatable:

```bash
pnpm run setup-trusted-publishing --bootstrap --setup-trust @lexical/a11y
# equivalently: --package a11y
```

Useful flags:

- `--package <name>` (or a positional `<name>`, repeatable) — restrict the run to the given package(s), matched by full npm name (`@lexical/a11y`) or unscoped short name (`a11y`). Omit to process every public package.
- `--dry-run` — print what would happen without touching the registry (works with both `--bootstrap` and `--setup-trust`)
- `--workflow <filename>` — override the workflow filename (default `pre-release.yml`)
- `--repo <owner/name>` — override the GitHub repo (default `facebook/lexical`)
- `--stub-version <semver>` — override the placeholder version (default `0.0.0-bootstrap.0`)
- `--registry <url>` — override the npm registry

In the default (check-only) mode the script also prints the npmjs.com
`/access` URL for each existing package and the exact values to enter
manually, as a fallback for when `npm trust github` isn't an option.

### Testing trusted publishing from a PR branch

The "Publish to NPM" workflow (`pre-release.yml`) exposes `ref`,
`channel`, and `increment-version` inputs so it doubles as a test
harness. Picking a branch in the "Run workflow" dropdown selects
which version of the workflow files run, and the inputs determine
what actually gets published. The workflow has no NPM_TOKEN secret to
fall back on — publishes always go through OIDC trusted publishing —
so a misconfigured trust setup fails loudly rather than silently
falling through to token auth.

A safe end-to-end test looks like:

| Input | Value |
| -- | -- |
| Branch (dropdown) | your PR branch |
| `ref` | your PR branch (same value) |
| `channel` | `dev` |
| `increment-version` | checked |
| `ignore-previously-published` | unchecked |

With `increment-version` on, the run bumps `package.json` to a fresh
prerelease (e.g. `0.46.0-dev.0`), commits + tags it on a `dev__release`
branch on origin, and publishes the monorepo under the `dev` dist-tag
via OIDC. The `latest` tag is untouched, so default `npm install`
users are unaffected. After it succeeds:

```bash
npm view lexical@dev version     # → the just-published prerelease
npm view lexical@latest version  # → unchanged
```

Cleanup (the prerelease itself can't be reused, but the git refs
should go):

```bash
git push --delete origin v0.46.0-dev.0 dev__release 0.46.0-dev.0__release
```

The `increment-version=true + channel=latest` combination is refused
by the workflow's guard job — real `latest` releases must go through
`version.yml` first.

## Release Procedure

This is the current release procedure for public releases, at least as of
May 2024 (~0.15.0).

The main branch should be "frozen" during this procedure (no other PRs should
be merged during this time). This avoids a mismatch between the contents of
the GitHub release (created from main in step 1) and the NPM release (created
from main in step 4).

1. Create a new version with the Github Actions "Create New Release Branch" workflow (`version.yml`)
2. Raise a PR against version branch created by that action
3. After PR is approved with passing tests, merge PR
4. After PR is merged to main, publish to NPM with the Github Actions "Publish to NPM" workflow (`pre-release.yml`)
5. Create a GitHub release from the tag created in step 1, manually editing the release notes
6. Announce the release in #announcements on Discord

## Release Protocol

1. All PRs with breaking changes must have `[Breaking Change]` in the PR's title with documentation of what followup actions consumers of the lexical library need to be aware of.
2. Monthly releases happen on the last week of the month, with a minor increment (eg. v0.20+1.0).
3. Anything in between will be a patch increment (eg. 0.20.0+1), unless there is a breaking change. 

## Website Team Page

The [team page](https://lexical.dev/community) displays core team
members, emeriti, and distinguished contributors. The `team.json` data is
generated from GitHub contributor information and some predetermined decisions in
the script to acknowledge emeriti and historically important distinguished contributors.

To update the team page data:

```bash
pnpm run update-team-data
```

This fetches the latest contributor data from GitHub and categorizes team members
based on recent activity (last 12 months). See `packages/lexical-website/src/data/README.md`
for more details on configuration and team categorization logic.
