---
sidebar_label: Upgrading
---

# Upgrading Lexical

Lexical is still `0.x`, so breaking changes ship in minor releases
(`0.52.0` to `0.53.0`). All packages are released together at one version.

**Upgrade every package at once.** Bump `lexical` and every `@lexical/*`
package you use to the same version in one step. Each `@lexical/*` release
depends on the matching `lexical` version, and an app must resolve exactly
one copy of each package; see [One Lexical per app](./concepts/one-lexical-per-app.md).

**Read the changelog between your version and the target.**
[CHANGELOG.md](https://github.com/meta/lexical/blob/main/CHANGELOG.md)
lists every release. From v0.23.0 on, each version starts with what an
upgrade has to act on: **Breaking changes**, each with **Detect** (what
identifies affected code) and **Migration** (what to change, often with
before and after code); **Behavior changes**, which keep building but behave
or render differently, each with **Verify** (what to test); and
**Deprecations**, each with its replacement. Apply the entries of every
version after yours up to and including the target, oldest first. Versions
before v0.23.0 only list their commits. The same file ships in the `lexical`
package, so an app can read it at `node_modules/lexical/CHANGELOG.md`,
offline and from coding agents.

To print only what applies to your upgrade, run this in a clone of the
repository:

```sh
pnpm run changelog:range -- --from 0.40.0 --to 0.52.0 --breaking
```

`--breaking` keeps breaking changes, behavior changes and deprecations.
Leave it out to include fixes and features, add `--json` for output that
tools can consume, and pass
`--changelog /path/to/app/node_modules/lexical/CHANGELOG.md` to read an app's
installed copy. Deprecated APIs keep working until they are removed in a
later breaking change; each deprecation names its replacement, so moving off
them while you upgrade avoids work later.

## Telling coding agents

If coding agents work on your app, add this to your project's `AGENTS.md`
(or the equivalent instructions file), so they read the changelog instead of
guessing from older training data:

```md
Lexical is 0.x and changes often. Before upgrading or writing Lexical code,
read node_modules/lexical/CHANGELOG.md from your installed version to the
target; apply every Migration, check every Detect, and test every Verify.
```

Lexical does not install this for you: there is no `postinstall` script, and
nothing is written to your project.
