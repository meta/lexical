# Vanilla JS Extension with a React plug-in host

Demonstrates using Lexical Extension to build a very basic checklist editor with Vanilla JS, using Tailwind for CSS, and rendering a React-based extension (`TreeViewExtension`) into the page with `ReactPluginHostExtension`.

- The editor is built with `buildEditorFromExtensions`, from `RichTextExtension`, `HistoryExtension`, `CheckListExtension` and others.
- `ReactPluginHostExtension` owns a React root. `mountReactPluginHost` mounts it, and `mountReactExtensionComponent` renders the tree view into `#tree-view`, so the app needs React at runtime but no JSX.
- `configExtension(TreeViewExtension, {...})` styles the tree view with Tailwind classes.
- `TailwindExtension` from `@lexical/tailwind` supplies the editor theme. `src/styles.css` points Tailwind at that package with `@source` so the classes it uses are generated.

**Run it locally:** `pnpm i && pnpm run dev`

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/meta/lexical/tree/main/examples/extension-vanilla-react-plugin-host?file=src%2Fmain.ts)
