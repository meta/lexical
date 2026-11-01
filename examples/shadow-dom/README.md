# Lexical Shadow DOM Example

A minimal [Vite](https://vitejs.dev/) + React app that demonstrates Lexical
across a Shadow DOM boundary in a _nested_ shape:

- An **outer editor** lives in the light DOM, with a `LexicalExtensionComposer`
  registering Rich Text, History, and Tab Indentation.
- An **inner editor** is mounted inside an open `ShadowRoot`, nested in the
  outer editor's tree via a `DecoratorNode` (`NestedEditorNode`).

The nesting exercises Lexical's platform-only shadow support:

- **Reading selection** uses
  [`Selection.getComposedRanges`](https://developer.mozilla.org/docs/Web/API/Selection/getComposedRanges)
  and [`Selection.direction`](https://developer.mozilla.org/docs/Web/API/Selection/direction),
  because `Selection.anchorNode` / `getRangeAt` are retargeted to the shadow
  host when the selection is inside a shadow tree.
- **Reading focus** uses
  [`ShadowRoot.activeElement`](https://developer.mozilla.org/docs/Web/API/DocumentOrShadowRoot/activeElement),
  because `document.activeElement` only reports the outermost shadow host.
- **Writing selection** uses the native `Selection.setBaseAndExtent`, and
  keyboard navigation / word + line deletion use the native `Selection.modify`,
  both of which operate on shadow-tree nodes directly.
- **Selection-change attribution** prefers the shadow-mounted candidate first
  when a `selectionchange` fires under a nested layout — so the inner editor
  wins attribution over its light-DOM parent.

## How it works

[`ShadowRoot.tsx`](./src/ShadowRoot.tsx) attaches an open shadow root to a host
`<div>` with `Element.attachShadow`, then portals its children (including the
inner editor's `contentEditable`) into the shadow tree with `createPortal`.
React context flows across the portal, so the inner editor is built exactly as
it would be in the light DOM — only its DOM lives behind the shadow boundary.
The inner editor's CSS is injected as a `<style>` element inside the shadow
root, since shadow trees do not inherit the document's stylesheets.

The `NestedEditorNode` in [`App.tsx`](./src/App.tsx) is a `DecoratorNode` whose
host sits in the outer editor's tree. Its `decorate()` returns a React subtree
that hosts the inner editor's `LexicalExtensionComposer` plus its shadow root —
so the inner editor lives at a real position inside the outer editor's
document.

The toolbar in [`Toolbar.tsx`](./src/Toolbar.tsx) lives in the light DOM and
dispatches commands (`FORMAT_TEXT_COMMAND`, undo/redo) that act on the _outer_
editor's selection.

## Running

```sh
pnpm i && pnpm run dev
```

To run it against the Lexical sources in this repository instead of the
published packages, use `pnpm run monorepo:dev`.

Then open the printed URL. Try:

- Typing in either editor — outer (light DOM) or inner (shadow root).
- Selecting words in the outer editor with `Alt`/`Ctrl` + `Shift` + arrow keys
  and pressing **Bold** / **Italic** / **Underline** in the toolbar.
- Word and line deletion with `Alt`/`Ctrl` + `Backspace`/`Delete` in either
  editor.

## Tests

[Playwright](https://playwright.dev/) tests in [`tests/`](./tests) cover
rendering both editors, typing across the shadow boundary, formatting an outer
selection via the light-DOM toolbar, and word deletion in the inner editor.
They start the dev server automatically:

```sh
pnpm run test
```
