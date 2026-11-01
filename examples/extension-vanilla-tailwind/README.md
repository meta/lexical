# Basic Vanilla JS Extension with Tailwind example

Demonstrates using Lexical Extension to build a very basic checklist editor with Vanilla JS (no React), using Tailwind for CSS.

- The editor is built with `buildEditorFromExtensions`, from `RichTextExtension`, `HistoryExtension`, `CheckListExtension` and others.
- `TailwindExtension` from `@lexical/tailwind` supplies a theme of Tailwind classes. `src/styles.css` points Tailwind at that package with `@source` so the classes it uses are generated.
- The "Editor state" panel is kept in sync by a small extension that reads the `EditorStateExtension` signal.
- `LazyExtension` shows how an extension can load more code with a dynamic `import()` and still clean up when the editor is disposed.

**Run it locally:** `pnpm i && pnpm run dev`

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/meta/lexical/tree/main/examples/extension-vanilla-tailwind?file=src%2Fmain.ts)
