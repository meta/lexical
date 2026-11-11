# Lexical Web Component (Shadow DOM) Example

A framework-free [Vite](https://vitejs.dev/) app that packages a Lexical
rich-text editor as a **custom element** (`<lexical-editor>`) whose toolbar,
styles, and `contentEditable` all live inside an **open `ShadowRoot`** —
the scenario from
[meta/lexical#2119](https://github.com/meta/lexical/issues/2119),
[#6709](https://github.com/meta/lexical/issues/6709), and
[#8125](https://github.com/meta/lexical/issues/8125).

Where the sibling [`shadow-dom`](../shadow-dom) example demonstrates a React
app with the editor in a shadow root and the toolbar outside it, this one
demonstrates the inverse packaging: a fully self-contained web component.
The demo page mounts four instances — three light-DOM `<lexical-editor>`
hosts inside the form (a `required` notes editor, a themable summary editor,
and a pre-rendered editor that hydrates from `<template shadowrootmode="open">`)
plus a fourth instance inside a wrapper `<div>` that opens its own shadow root,
so the editor's contentEditable sits two shadow boundaries below the document
and exercises the multi-level walk through `getDOMShadowRoots`. Everything
runs on platform APIs only:

- `Element.attachShadow({mode: 'open'})` in `connectedCallback`, with the
  editor built by `@lexical/extension`'s `buildEditorFromExtensions` and torn
  down (`editor.dispose()`) in `disconnectedCallback`.
- **Form association** through the standard
  [`ElementInternals`](https://developer.mozilla.org/docs/Web/API/ElementInternals)
  API — each editor submits its serialized editor state with the surrounding
  `<form>`, no hidden `<input>` required.
- **`required` validation** through
  [`ElementInternals.setValidity`](https://developer.mozilla.org/docs/Web/API/ElementInternals/setValidity),
  driven by the editor's plain text content. A `<lexical-editor required>`
  participates in `form.checkValidity()` and the browser's native invalid-form
  UI just like a `<textarea required>`.
- **`disabled` and `readonly` attributes** that flip Lexical's editable
  state. `disabled` also drops the editor out of `FormData` and skips
  validation, matching `<input disabled>`; the
  [`formDisabledCallback`](https://developer.mozilla.org/docs/Web/API/Web_components/Using_custom_elements#form-associated_callbacks)
  picks up an ancestor `<fieldset disabled>` automatically.
- **CSS custom property theming** — the editor exposes `--lexical-bg`,
  `--lexical-fg`, and a small palette of toolbar variables on its host
  element. The page redefines them to recolour the editor; inherited
  custom properties cross the shadow boundary on their own, so the
  internal layout stays private.
- **Toolbar slot** — `<button slot="toolbar-extra">` projects a
  light-DOM button into the editor's toolbar row. The button stays in
  the page (its click never crosses the boundary), but the page can drive
  the editor through the host's public API.
- **Floating selection popover** — the editor emits a composed
  `lexical-selection-rect` `CustomEvent` carrying the live viewport
  rect of the selection inside its shadow root, computed through
  Lexical's `getDOMSelectionRangeAndPoints`. A page-level
  [popover](https://developer.mozilla.org/docs/Web/API/Popover_API)
  positions itself from those coordinates and drives bold / italic /
  underline back through the host's editor.
- A composed `input` event that crosses the shadow boundary so the page can
  observe edits.
- Selection inside the shadow root is resolved by Lexical itself via
  `Selection.getComposedRanges` / `Selection.direction`, and focus via
  `ShadowRoot.activeElement`.

## Running

```sh
pnpm i && pnpm run dev
```

To run it against the Lexical sources in this repository instead of the
published packages, use `pnpm run monorepo:dev`.

Then open the printed URL. Try:

- Typing in any of the four editors and switching between them (each keeps
  its own selection and history).
- Selecting words with `Alt`/`Ctrl` + `Shift` + arrow keys, then using the
  in-shadow toolbar buttons — they reflect the selection's formats.
- Word/line deletion with `Alt`/`Ctrl` + `Backspace`/`Delete`.
- Submitting the form to see each editor's serialized state in the output.
- Submitting the form while the first editor (`required`) is empty: the
  browser blocks the submit and surfaces its native validation tooltip on
  the editor.
- Clicking the **Clear** button next to the notes toolbar — that button
  lives in the light DOM and is projected through the `toolbar-extra`
  slot, then drives the editor through the host's public API.
- Toggling the **Lock the summary editor** checkbox to flip the
  `readonly` attribute on the summary editor, then trying to type
  inside it: the contentEditable refuses input, but the form still
  submits the value.
- Selecting a few words in either editor — the floating B / I / U
  popover appears anchored under the selection (in the page, not the
  shadow root), and clicking it formats the text through the editor.
- Switching the OS or browser between light and dark mode (or
  redefining `--lexical-bg`, `--lexical-fg`, etc. in the page CSS) to
  see how page-side CSS variables retheme each editor without touching
  its shadow root.

## Tests

[Playwright](https://playwright.dev/) tests in [`tests/`](./tests) cover the
editors rendering in independent shadow roots (including the nested
editor inside the wrapper shadow root), typing and formatting, editor
independence, word deletion, `ElementInternals` form association, the
composed `input` event crossing the shadow boundary, and the floating
popover anchoring to a selection inside the nested shadow root. They
start the dev server automatically:

```sh
pnpm run test
```

## What's covered

This example aims to be a full reference a production user can copy out.
The Playwright suite covers each of the surfaces above plus a second
round of audit items:

- DOM-move state round-trip (`disconnectedCallback` caches the
  serialized state, `connectedCallback` restores it)
- `delegatesFocus: true` on the shadow root + `tabindex="0"` on the
  contentEditable
- `host.setCustomValidity()` + the standard `validity` / `willValidate`
  / `checkValidity` / `reportValidity` surface
- `formAssociatedCallback` + `host.form`, `formResetCallback`,
  `formDisabledCallback`, `formStateRestoreCallback` (bfcache / autocomplete)
- The standard `inert` attribute, `aria-label` / `aria-invalid` /
  `role="textbox"` mirroring
- A composed `lexical-validity-change` event for a visible error
  message
- `@media (prefers-color-scheme: dark)` / `(prefers-reduced-motion)` /
  `(forced-colors: active)` inside the shadow stylesheet
- Declarative shadow DOM (`<template shadowrootmode>`) — the third
  editor on the demo page pre-renders its shadow content and our
  `connectedCallback` reuses the existing `.content` element instead
  of creating a fresh contentEditable
- Hardened lifecycle: a duplicate `customElements.define` of the
  same tag throws `NotSupportedError` (the shipped helper guards
  against this); a host that fails to build doesn't crash the
  surrounding page

The playground e2e suite (`packages/lexical-playground/__tests__/e2e/ShadowDOM.spec.mjs`)
covers the corresponding playground-side surfaces: markdown shortcuts
(`# heading`, `- list`) and `@lexical/list` inside the shadow root,
`@lexical/history` undo/redo, the tree-view mirror, pointer events
(`composedPath` recovery for touch / pen / mouse), HTML paste
sanitization (a `<script>` tag is stripped), a large keyboard input
that keeps the reconciler responsive, image insert + paste,
NodeSelection on image click, blur + re-focus through the shadow
boundary, Korean and Chinese IME composition cycles, and yjs
convergence between two clients each rendered inside its own open
shadow root.

`lexical-devtools` descends through open shadow roots using the same
helpers this PR adds (`getDOMShadowRoots` / `getActiveElementDeep` /
`getEditorPropertyFromDOMNode`), so it resolves the shadow-mounted
editor without dev-example-side glue. Closed-mode shadow roots remain
opaque to a page-level integration by spec — the concept page documents
the limitation and the browser-unit suite verifies the helpers behave
correctly when a host attaches a closed root.

A handful of newer platform APIs are not exercised by this single
example because they slot in at the page layer rather than the editor
itself: the
[View Transitions API](https://developer.mozilla.org/docs/Web/API/View_Transitions_API)
animates between shadow-mounted instances on `document.startViewTransition`
without any editor-side glue, and the
[CSS Custom Highlight API](https://developer.mozilla.org/docs/Web/API/CSS_Custom_Highlight_API)
(`Highlight` + `::highlight()`) styles ranges that span the shadow
boundary as long as the page hands them un-retargeted boundary points —
the same shape `getDOMSelectionRangeAndPoints` already returns.
