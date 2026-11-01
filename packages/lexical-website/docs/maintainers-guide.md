# Maintainers' Guide

This is the grimoire of arcane knowledge covering the overall organization
of the Lexical monorepo, including its conventions, quirks, and
configurations.

## Monorepo Organization

### Workspaces

The monorepo is configured with
[pnpm workspaces](https://pnpm.io/workspaces); the set of workspace
packages is declared in the top-level `pnpm-workspace.yaml`. This mostly means that all packages share a
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
    "url": "git+https://github.com/meta/lexical.git",
    "directory": "packages/lexical-eslint-plugin"
  },
  "main": "LexicalEslintPlugin.js",
  "types": "index.d.ts",
  "bugs": {
    "url": "https://github.com/meta/lexical/issues"
  },
  "homepage": "https://github.com/meta/lexical#readme"
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
package needs (the `dev`/`prod` ESM variants plus their fork modules,
`.d.ts` declarations, and `.js.flow` stubs under
`packages/<name>/dist/`), then runs the publish-time guard in
`scripts/npm/prepare-release.mjs` to confirm every path the package's
`exports`/`main`/`module`/`types` fields reference actually exists on
disk. The guard fails the build if e.g. you ran `pnpm run build` (dev
only) and then tried to publish — the `.prod.js` files would be
missing.

It also copies the root `CHANGELOG.md` into `packages/lexical/` (the copy is
gitignored), so the full release history ships with the `lexical` package
for anyone upgrading from an installed version. For a prerelease (nightly,
next, dev) the copy also lists the pending changesets under
`## Unreleased`; the repository's CHANGELOG.md is not changed.

Only ESM is published to npm. Every public package is a
`"type": "module"` package (`update-version` adds the field), so its
build is plain `.js`. A CommonJS consumer gets the same files through
Node's `require(esm)` (Node.js 20.19+), which is why the fork module that
the exports map's `default` condition resolves to has no top-level await.
The CommonJS variants are only built for www (`pnpm run build-www`).

Because a `.d.ts` in a `"type": "module"` package is an ES module
declaration, the build gives the relative imports tsc emits an explicit
`.js` extension (`from './LexicalEditor.js'`): TypeScript's `nodenext`
resolution does not resolve extensionless relative imports in ESM, and a
consumer with `skipLibCheck` would silently get `any` for everything.
`scripts/__tests__/integration/declaration-resolution.test.mjs` checks
that a `nodenext` consumer of every entry point still sees the types.

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

### pnpm run generate-node-json

Regenerate the specialized JSON serialization code for the built-in node
classes. A node's [serialization schema](/docs/serialization/#declarative-serialization-schemas-with-config)
states everything about a serialized property ahead of time — which accessor
or field it uses, what its default is, what its domain admits — so the
generic walk over that schema can be compiled into straight-line code. This
script does that compiling; the output is checked in.

It writes one module per package, beside the nodes it serializes:

| Module | Classes |
| --- | --- |
| `packages/lexical/src/LexicalGeneratedJSON.ts` | ElementNode, TextNode, ParagraphNode, LineBreakNode, TabNode |
| `packages/lexical-rich-text/src/LexicalRichTextGeneratedJSON.ts` | HeadingNode, QuoteNode |
| `packages/lexical-link/src/LexicalLinkGeneratedJSON.ts` | LinkNode, AutoLinkNode |
| `packages/lexical-mark/src/LexicalMarkGeneratedJSON.ts` | MarkNode |
| `packages/lexical-list/src/LexicalListGeneratedJSON.ts` | ListNode, ListItemNode |
| `packages/lexical-table/src/LexicalTableGeneratedJSON.ts` | TableNode, TableRowNode, TableCellNode |
| `packages/lexical-code-core/src/LexicalCodeCoreGeneratedJSON.ts` | CodeNode, CodeHighlightNode |
| `packages/lexical-react/src/shared/LexicalReactGeneratedJSON.ts` | DecoratorBlockNode |

Each class receives its own generated code through its `$config`'s
`generated` property, so nothing has to match code to class by type string at
runtime. What the property holds is a factory: registration calls it with the
class's composed schema, and the generated code reads the lookup tables it
needs (`getterTable`, `setterTable`, `aliasedValue`'s) off that schema through
`getterTableOf`, `setterTableOf` and `aliasTableOf`, so a generated module
carries no copy of a table and nothing about a table's contents is written at
build time — only its type, so the field a value is assigned to is still
checked. A subclass inherits the code along with the schema when its compiled
accessor tables are the ones the code was generated from — checked entry for
entry at registration — and runs it over its own schema, while one that
overrides an accessor a field stands in for, or declares a serialized property
of its own, resolves differently and takes the schema-driven walk instead.
Generated exporters read `type` off the node for the same reason.

Three things are worth knowing before touching it:

- **The output is verified, not trusted.** The import direction is the
  untrusted-JSON boundary, so every generated parser is run against the schema
  it was compiled from over a corpus drawn from that schema plus a fixed set of
  hostile values (`'__proto__'`, `'toString'`, `'1e999'`, …). A property whose
  schema cannot be compiled faithfully takes its class out of the import half
  rather than shipping a parser that disagrees with the walk — the script says
  so on stdout when it happens.
- **A stale checkout fails the tests.** `LexicalGeneratedJSON.test.ts`
  regenerates into a temporary directory and compares every file byte for
  byte, and separately asserts that each generated exporter agrees with the
  schema-driven walk for both the legacy and compact forms. Change a schema
  without rerunning this script and that test fails.
- **Two lists, deliberately.** The script runs in two phases, because reading
  the schemas means importing the packages and each package imports the file
  the script writes for it. Phase one replaces every output with a valid
  do-nothing stub from the static `MANIFEST` in
  `scripts/shared/generateNodeJSONManifest.mjs` so the imports always succeed;
  phase two re-enters under `tsx` and writes the real thing from `PACKAGES` in
  `scripts/shared/generateNodeJSON.mjs`, which is also what the drift test
  runs in-process. Adding a class means editing both lists, and the generation
  fails loudly if they disagree.

The compact form compares each property against its default. A primitive
default is a literal; a reference-typed default has no literal a value could
be `===`, so it gets the structural test the schema's own equality reduces to
where that can be stated — MarkNode's `ids`, whose default is an empty array,
becomes a length test — and every emitted comparison is verified against that
equality over a corpus, the way a parse is. A default the generator cannot
state that way (an object, a non-empty array, a non-finite number) takes the
class out of the compact half only: the script says so on stdout and the other
forms are generated as usual. A class that carries flat NodeState is generated
like any other; the walk applies the state before handing the node to the
generated parser, the mirror of how export appends it after the generated
literal.

`afterCloneFrom` is generated too, and is the one direction whose fallback is
not the walk. A schema field is where a property is *stored*, so every class
that declares one gets an `afterCloneFrom` synthesized at registration —
generated straight-line code when the class has some, and otherwise a loop over
the field names — copying the fields that class's own `$config` declared and
delegating the rest through `super`, which is why the emitted function covers
one class's own fields and nothing above it. A field an ancestor declares too
is left to the ancestor, whose method has already assigned it: re-declaring an
inherited property changes how it is serialized, not where it is stored, so a
class that only re-declares gets no method at all — `TabNode`, which restates
`TextNode`'s `text`, `detail` and `mode`, is the in-tree case and simply
inherits `TextNode`'s. Both accessor directions are read
for a field name, and the declared field is used rather than the one
`resolveGetterAccessor` resolves to: an override changes how a property is
serialized, not where it lives. A class that writes its own `afterCloneFrom` is
left alone and owns all of its properties, which is how `ElementNode` keeps
carrying `__first`/`__last`/`__size` and its slot bookkeeping; so is a property
declared through accessor methods on both sides, which names no field for
anything to copy. No in-tree node is in that second position — a property held
in a field says so with `setter: {field, method}` and stays derived, as
`MarkNode`'s `ids` does — so the boilerplate that remains is `ElementNode`'s
and `CodeNode`'s, and each of those calls the generated `afterClone<Class>`
for its schema half and writes only the fields no schema describes.
`ownSchemaFields` in `LexicalUtils.ts` is the single definition of that field
list, called by both the generator and the synthesized fallback.

The schema-to-JavaScript compiler itself lives in `@lexical/compiler`'s
`SchemaJsonCodegen` entry point, so it is testable independently of the
generator that drives it.

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
`minor` | `patch` | `prerelease`. A `patch` on the `latest` channel is
refused while a `[breaking]` changeset is pending in `.changeset/`; breaking
changes ship in minor releases.

The postversion script will:
- Create a local `${CHANNEL}__release` branch (the version-named
  `${npm_package_version}__release` branch is only a remote push target,
  and only when the channel is not `nightly`)
- `pnpm run update-version` to update example and sub-package monorepo dependencies
- `pnpm install` to update the pnpm-lock.yaml
- `pnpm run update-packages` to update other generated config
- `pnpm run extract-codes` to extract the error codes and
  `pnpm run update-changelog` to turn the pending changesets into a new
  CHANGELOG.md version block, followed by an `### All changes` list of the
  commits since the previous release, and delete them (both only when
  `CHANNEL` is `latest`; prerelease changes stay pending until the next
  `latest` release). `update-changelog` refuses to run while the previous
  release is missing from CHANGELOG.md, that is, until the previous release
  PR is merged, so the same changesets cannot end up in two releases. With
  `GITHUB_TOKEN` set it looks up pull requests and contributor logins that
  git history does not show
- Create a version commit and tag from the branch

This is typically executed through the `version.yml` GitHub Workflow which
will also push the tag and branch.

### pnpm run changelog

Preview the CHANGELOG.md block that the pending changesets in `.changeset/`
would produce, without changing anything. See
[.changeset/README.md](https://github.com/meta/lexical/blob/main/.changeset/README.md)
for the changeset format and `pnpm run check-changesets` to validate them.

### pnpm run changelog:range

`pnpm run changelog:range -- --from 0.40.0 [--to 0.52.0] [--breaking] [--json]`
prints every CHANGELOG.md entry after `--from` up to `--to`, oldest first.
`--breaking` keeps only breaking changes and deprecations. `--changelog
<file>` reads another copy, such as an app's
`node_modules/lexical/CHANGELOG.md`, which apps can also read directly.

### pnpm run changeset:new

`pnpm run changeset:new -- --category fix --packages lexical,@lexical/list --summary "..." [--pr 123]`
writes a valid changeset; for `breaking` and `deprecation` it leaves TODO
lines for the required paragraphs, which `check-changesets` rejects until
they are filled in.

### pnpm run release-notes

`pnpm run release-notes -- --version 0.53.0` prints that version's
CHANGELOG.md block without its heading: an optional starting point for the
GitHub release notes.

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
- `--repo <owner/name>` — override the GitHub repo (default `meta/lexical`)
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

## Continuous releases (pkg.pr.new)

Every commit to a pull request and every commit to `main` publishes all public
packages to [pkg.pr.new](https://github.com/stackblitz-labs/pkg.pr.new) through
the `pkg-pr-new.yml` workflow. Nothing goes to npm: the nightly, next and latest
channels above are unchanged and still publish through `call-release.yml`.

```sh
npm i https://pkg.pr.new/lexical@9372      # latest commit of PR #9372
npm i https://pkg.pr.new/lexical@4282a68   # a specific commit
npm i https://pkg.pr.new/lexical@main      # tip of main
```

The bot comments install commands on each pull request. Previews are built
with `pnpm run prepare-release`, the same build as the npm channels, after
`scripts/npm/preview-version.mjs` stamps a version in the nightly line:
`0.52.1-pr.9372.g4282a68` for a PR and `0.52.1-main.g4282a68` for `main`, next
to `0.52.1-nightly.20261019.0` on npm. That version is also what
`LexicalEditor.version` reports. Dependencies between Lexical packages are
rewritten to the same commit's pkg.pr.new URLs, so `@lexical/react` from a
preview depends on `lexical` from that preview, not on an npm release.

The bot's comment lists npm commands, and npm dedupes those dependencies by
name and version, so `@9372` or `@main` URLs install one copy of each
package. `npm ls` still marks `lexical` (and any other package installed
that way that Lexical packages depend on) `invalid` then, and exits with 1:
the packages depend on each other through the 7-character commit URL
(`…/lexical@4282a68`), not the one you installed. Install with the
7-character commit URLs to keep that check clean. pnpm and yarn key URL
dependencies by URL instead: install with the long commit URLs that the
packages use for each other, or you get more than one copy of `lexical`. pnpm
11+ also refuses URL dependencies of URL dependencies unless
`blockExoticSubdeps` is off. Each run's job summary lists these commands:

```sh
pnpm add --config.block-exotic-subdeps=false \
  lexical@https://pkg.pr.new/meta/lexical/lexical@4282a68 \
  @lexical/react@https://pkg.pr.new/meta/lexical/@lexical/react@4282a68
yarn add \
  lexical@https://pkg.pr.new/meta/lexical/lexical@4282a68 \
  @lexical/react@https://pkg.pr.new/meta/lexical/@lexical/react@4282a68
```

On a cold cache, yarn 1 can fail with "the file appears to be corrupt" while
it downloads the same URL for several packages at once. Run it again.

The workflow requires the [pkg.pr.new GitHub App](https://github.com/apps/pkg-pr-new)
to be installed on the repository.

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
5. Create a GitHub release from the tag created in step 1, manually editing the release notes. `pnpm run release-notes -- --version <version>` prints the new CHANGELOG.md section, which can be a starting point under the hand-written notes
6. Announce the release in #announcements on Discord

## Release Protocol

1. All PRs with breaking changes must have `[Breaking Change]` in the PR's title with documentation of what followup actions consumers of the lexical library need to be aware of.
2. Every user-facing PR also adds a changeset (see "Changesets" in CONTRIBUTING.md); for a breaking change it is a `[breaking]` changeset whose `Migration:` paragraph is that documentation. A maintainer can write the changeset for an external contributor (with a `PR: #123` line when it lands in a later PR) or add the `skip-changeset` label when the change has no effect on users. The changesets become the CHANGELOG.md entry at the next release.
3. Monthly releases happen on the last week of the month, with a minor increment (eg. v0.20+1.0).
4. Anything in between will be a patch increment (eg. 0.20.0+1), unless there is a breaking change. A patch release is refused while a `[breaking]` changeset is pending; if an urgent fix has to ship then, release a minor instead (on 0.x that is the same kind of release a monthly one is), rather than holding back or splitting the breaking change.

### Changesets

The Changesets workflow (`.github/workflows/changesets.yml`) reports a pull
request that changes a published package's code without a changeset. It runs
the checker from the pull request's base revision, so a pull request cannot
loosen the rules it is checked by. Its `CHANGESET_COVERAGE` setting decides
what happens:

- `warn` (the current setting): the missing changeset is written to the job
  summary and as an annotation naming the file to add, with a link that opens
  it prefilled on the pull request's branch; the check passes.
- `error`: the check fails until a changeset is added or a maintainer adds
  the `skip-changeset` label.

It stays at `warn` until the `skip-changeset` label exists: contributors
cannot skip the check themselves, so failing before then would block a
drive-by contribution on a step only a maintainer can take. Once the label
exists, flip it to `error`. Do not make the check required in branch
protection until it has run cleanly for about a month. Malformed changeset
files always fail `pnpm run ci-check`, whatever the setting.

When reviewing, add a `Verify:` paragraph to a fix's changeset if the fix
changes observable output or behavior, so it is listed under "Behavior
changes".

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
