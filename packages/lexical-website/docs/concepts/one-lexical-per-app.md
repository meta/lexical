---
sidebar_label: One Lexical per app
---

# One Lexical per app

`lexical` is effectively a singleton **within one app**: an app must resolve
exactly **one** copy of `lexical`, and one copy of each `@lexical/*` package it
uses. Two copies in the same bundle do not merely waste bytes — they break the
editor in ways whose error messages point nowhere near the real cause.

The practical consequence, covered in [Publishing a library](#publishing-a-library)
below: **a library built on Lexical declares `lexical` and the `@lexical/*`
packages it imports as `peerDependencies`, never as `dependencies`. The
application brings its own Lexical.**

:::note

This page is about npm `peerDependencies` in your `package.json`. Extensions
have their own, unrelated notion of
[peer dependencies](../extensions/peer-dependencies.md) — optional links between
extensions inside one editor.

:::

## The boundary is the app, not the page

Several self-contained apps can share a page, each with its own bundled copy of
Lexical, and that is fine — a CMS page with two independently deployed widgets
on it, or a micro-frontend setup, does not have a bug just because two copies of
`lexical` are loaded. Lexical anticipates this: `isLexicalEditor()` is an
`instanceof` check specifically "to prevent issues with multiple embedded
Lexical installations", and an editor is tagged on its own root element rather
than in any page-global registry, so each app's editors resolve to that app's
Lexical and ignore the others.

What those apps cannot do is interoperate. Two copies have no compatible API
surface between them, so treat each as a sealed island:

- do not pass nodes, editors, `EditorState` objects, selections or commands
  across the boundary — pass serialized JSON or HTML, which is data rather than
  identity;
- a plugin, node package or shared editor config must be bundled with the app it
  serves, not shared as a live import between apps;
- `@lexical/react` context does not cross the boundary either, since the context
  object itself comes from one copy.

The rest of this page is about the failure case: two copies **inside one app**,
where code from copy A is expected to work with an editor from copy B.

## Why one copy per app

Lexical keeps state at module scope, and identifies things by reference rather
than by name. Both assumptions hold only within a single copy of the module.

- **The active editor is module state.** `activeEditor`, `activeEditorState`
  and `isReadOnlyMode` live at module scope in `LexicalUpdates.ts`, and every
  `$` function reads them. `editor.update()` in copy A sets copy A's variables;
  a `$` function imported from copy B reads copy B's, which are still `null`
  ([Editor State](editor-state.md)).
- **Node classes are compared by identity.** Node registration and the
  `instanceof LexicalNode` checks compare class references. A node that extends
  `LexicalNode` from copy A is not, as far as copy B is concerned, a
  `LexicalNode` at all — even though both classes have the same name and come
  from the same published version ([Nodes](nodes.mdx)).
- **Commands are object identities.** `createCommand()` returns a fresh `{type}`
  object, and `registerCommand`/`dispatchCommand` match on that object, not on
  its `type` string. Two copies of `lexical` export two distinct
  `FORMAT_TEXT_COMMAND` objects, so a dispatch from one never reaches a listener
  registered with the other ([Commands](commands.md)).

On top of that, two copies are usually two *versions*, which is API drift inside
a single editor: half your plugins were compiled against a different API and
serialization format than the editor running them, and the mismatch surfaces
only at runtime, on the paths that happen to differ.

## Symptoms of a duplicated Lexical

The errors are unhelpfully literal — a class that plainly does implement
`getType()` is reported as not implementing it, because the check is running
against the other copy:

```
LexicalNode: Node FooNode does not implement .getType().

Create node: Type heading in node HeadingNode does not match registered node
HeadingNode with the same type

createEditor: nodes[0] FooNode (type foo) is not a constructor that subclasses
LexicalNode from the lexical package used by this editor (0.50.0)

Unable to find an active editor state. State helpers or node methods can only be
used synchronously during the callback of editor.update(), editor.read(), or
editorState.read(). Detected on the page: 0 compatible editor(s) with version
0.50.0 and incompatible editors with versions 0.49.0
```

That last sentence is Lexical telling you directly that it found editors built
from another copy — a version different from its own, or the same version marked
`(separately built, likely a bundler configuration issue)`. Note that this
diagnostic scans the whole page, so a genuinely separate app that ships its own
Lexical is counted there too; it is evidence of a bug only when those editors
were supposed to be part of *your* app.

Silent failures look like: a command that dispatches but never fires its
listener, `$getSelection()` returning `null` inside an update, or a custom node
rendering as plain text after a copy/paste. Real reports of this failure mode:
[#4225](https://github.com/meta/lexical/issues/4225) and
[#7819](https://github.com/meta/lexical/issues/7819).

## Publishing a library

If you publish a package that imports from `lexical` or `@lexical/*` — a plugin,
a node package, a shared editor config, an in-house wrapper in a monorepo — put
those packages in `peerDependencies`, and in `devDependencies` so you can still
build and test:

```json
{
  "name": "my-lexical-plugin",
  "peerDependencies": {
    "lexical": ">=0.50.0",
    "@lexical/react": ">=0.50.0",
    "@lexical/utils": ">=0.50.0"
  },
  "devDependencies": {
    "lexical": "0.50.0",
    "@lexical/react": "0.50.0",
    "@lexical/utils": "0.50.0"
  }
}
```

Notes on the ranges:

- Lexical is pre-1.0, so `^0.50.0` means `>=0.50.0 <0.51.0` — a caret peer range
  locks your users out of the next release. Prefer an open `>=` range (or an
  explicit `>=0.50.0 <1.0.0`) so an app can upgrade Lexical without waiting for
  you.
- Mark a peer optional with
  [`peerDependenciesMeta`](https://docs.npmjs.com/cli/configuring-npm/package-json#peerdependenciesmeta)
  when the import is behind an opt-in entry point, the way this repo's own
  packages mark `typescript` optional.
- Do not add `lexical` to `dependencies` "just so it installs". That is exactly
  what pins a second copy under `node_modules/your-lib/node_modules/lexical` as
  soon as your range and the app's range disagree.

## Application setup

The application owns the version, and every Lexical package it installs moves
together:

- Install `lexical` and each `@lexical/*` package you use **at the same
  version**. Published `@lexical/*` packages depend on the exact matching
  `lexical` version (the monorepo's `workspace:*` is rewritten to an exact
  version at publish time), so `@lexical/react@0.50.0` beside `lexical@0.49.0`
  guarantees a nested second copy.
- Verify there is only one **per app**, from the app root:

  ```sh
  npm ls lexical @lexical/react     # or: pnpm why lexical / yarn why lexical
  ```

  More than one resolved version, or a path with a nested `node_modules/lexical`
  in it, is the bug.
- In a monorepo or a linked-package setup (`npm link`, `pnpm link`, a Yalc
  copy), the linked library resolves Lexical from *its own* `node_modules` and
  duplicates are the default rather than the exception. Deduplicate explicitly:
  hoist the dependency to the workspace root, or force resolution with
  [pnpm `overrides`](https://pnpm.io/settings#overrides), Yarn `resolutions`, or
  `npm dedupe`.
- Bundlers can also be told to collapse duplicates — Vite
  [`resolve.dedupe`](https://vite.dev/config/shared-options.html#resolve-dedupe),
  webpack `resolve.alias` pointing each package at one path:

  ```js
  // vite.config.js
  export default {
    resolve: {dedupe: ['lexical', '@lexical/react', '@lexical/utils']},
  };
  ```

  Treat that as a safety net, not a fix: it collapses copies that are already
  version-compatible, and cannot rescue two genuinely different versions.
- Duplication does not always come from the dependency tree: importing Lexical
  through both `import` and `require` pulls in the ESM and the CJS build of the
  *same* version, which are still two copies. The
  [React FAQ](../react/faq.md#lexicalcomposercontextuselexicalcomposercontext-cannot-find-a-lexicalcomposercontext)
  covers how this one shows up in `@lexical/react`.
