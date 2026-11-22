# Next.js + `@lexical/code-shiki` example

A minimal [Next.js](https://nextjs.org/) app that drives a Lexical rich-text
editor with Shiki-based code highlighting, wired entirely through the
Lexical [Extension](https://lexical.dev/docs/extensions/intro) system.

## What it demonstrates

- Using `LexicalExtensionComposer` (from `@lexical/react/LexicalExtensionComposer`)
  with `RichTextExtension`, `HistoryExtension`, `AutoFocusExtension`, and a
  small example-owned `CodeShikiDemoExtension` that pulls in
  `CodeShikiExtension` as a dependency. No legacy `LexicalComposer` /
  `*Plugin` wrappers.
- Driving `@lexical/code-shiki`'s public API from the extension:
  - `getCodeLanguageOptions()` to seed the editor with the language list
    that shiki has bundled metadata for, via the extension's
    `$initialEditorState` hook.
  - `loadCodeLanguage('python')` from the extension's `register` hook to
    exercise shiki's dynamic `@shikijs/langs/<lang>` import path through
    Next.js' bundler. Once the promise resolves and `isCodeLanguageLoaded`
    confirms it, the extension appends `Loaded: python` to the document.

## Why this example exists

This is also the release-artifact integration test for `@lexical/code-shiki`.
`scripts/__tests__/integration/prepare-release.test.mjs` globs
`examples/*/package.json`, installs each one against the freshly built
`npm/*.tgz` tarballs, runs `npm run build` (so Next.js bundles the example
against the published `@lexical/code-shiki`), then runs `npm run test`
(Playwright) against the production build. The Playwright assertions
confirm:

1. `Registered:.*typescript` — the synchronous `bundledLanguagesInfo` list
   resolved through the published bundle.
2. `Loaded: python` — the dynamic `import('@shikijs/langs/python')`
   inside shiki resolved at runtime, which only works if
   `shiki` / `@shikijs/*` are **external** in the published
   `@lexical/code-shiki` bundle rather than inlined by Rollup.

## Local development

```bash
pnpm install
pnpm run dev        # next dev on http://localhost:3000
pnpm run build      # next build
pnpm run start      # next start (used by playwright.config.ts)
pnpm run test       # playwright tests against the built app
```
