# Keyboard Accessibility

Lexical follows the [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/) keyboard model. This page documents the contracts that plugin authors and host applications rely on, so a Lexical editor can sit inside a larger keyboard-accessible flow without trapping or surprising the user.

## Tab key

By default, `Tab` inside the editor follows the browser's normal focus order — it moves to the next focusable element on the page. There is no keyboard trap.

The optional `TabIndentationExtension` (`@lexical/extension`) takes over `Tab` and uses it for block indent / outdent. Hosts that mount this extension opt in to that behavior. WCAG 2.1.2 (No Keyboard Trap) still applies — pressing `Escape` blurs the editor (see below), at which point `Tab` leaves the editor again.

## Escape key

Pressing `Escape` while the editor has focus calls `editor.blur()` via the rich-text Escape command handler (registered at `COMMAND_PRIORITY_EDITOR`). The handler only blurs when the current selection is a range selection; with a `NodeSelection` (or no selection) it returns `false` and falls through without blurring. After blur, the next `Tab` advances to the page's next focusable element — so the editor is not a hard keyboard trap. (`TabIndentationExtension` consumes `Tab` only while a range selection is active, and its own source notes that taking over `Tab` is generally discouraged for keyboard accessibility, so treat WCAG 2.1.2 conformance as something to verify in your integration rather than a guarantee.)

Plugin authors who want to intercept `Escape` (modal close, dropdown close, etc.) should register their handler at a higher priority and return `true` to stop the command chain. Common patterns already established in the codebase:

| Priority | Caller | Purpose |
| --- | --- | --- |
| `HIGH` | Floating link editor | Close the floating UI, keep editor focus |
| `HIGH` | Equation component (while editing) | Close the equation editor input |
| `NORMAL` | Comment plugin | Cancel inline comment editing |
| `LOW` | Image component | Escape out of caption / resize editing: drop the inner selection and restore the `NodeSelection` on the image decorator |
| `EDITOR` | Rich text (default) | `editor.blur()` (range selection only) |

Handlers that return `false` let the chain continue, so Escape can still fall through to the default blur even after a higher-priority handler runs.

Some host UI binds its close handler directly to a DOM `keydown` listener rather than going through `KEY_ESCAPE_COMMAND` — the playground's `Modal` via `window.addEventListener('keydown', ...)` and its `DropDown` via a React `onKeyDown` on the menu. Those paths run alongside the table above; they do not participate in the editor's command priority chain.

## React hooks and `@lexical/a11y` extensions

The keyboard helpers below ship as `@lexical/a11y` _extensions_ — the extension is the API and does all of the work (event listeners, focus management, the live region). The `@lexical/react` hooks (`useLexicalFocusManagerRef`, `useLexicalRovingTabIndexRef`, `useLexicalFocusTrapRef`, `useLexicalAriaLiveRegion`) are thin React adapters that only _communicate_ with their extension: each returns a `RefCallback` (or an `announce` function) that drives the extension's signals. Using a hook therefore **requires** its matching extension to be registered in the editor's extension tree — it is not an optional integration path. Non-React hosts (Svelte, Vue, vanilla DOM) use the extensions directly and skip the hooks.

## Toolbar focus jump

The playground uses `useLexicalFocusManagerRef` (`@lexical/react/useLexicalFocusManagerRef`) to provide a documented shortcut for moving focus from the editor to the toolbar without tabbing through the page. The hook returns a `RefCallback` that registers the attached element as a focus-managed toolbar. It listens for `Alt+F10` inside the editor and moves focus into the toolbar — preferring the item that currently carries `tabindex="0"` (the active roving item, when paired with `useLexicalRovingTabIndexRef`), and otherwise the first focusable item. While focus is in the toolbar, pressing `Escape` restores both focus and the editor's prior selection via `editor.focus()`. Multiple toolbars can be registered simultaneously. Requires `FocusManagerExtension` from `@lexical/a11y` in the editor's extension tree.

This matches the WAI-ARIA editor menubar pattern and the convention used by Word and CKEditor. Hosts that don't mount `useLexicalFocusManagerRef` get the default browser flow (Tab in, Tab out).

## Toolbar arrow-key navigation

Toolbars that opt into `useLexicalRovingTabIndexRef` (`@lexical/react/useLexicalRovingTabIndexRef`) collapse to a single tab stop: arrow keys move between items inside the toolbar; `Tab` moves past the toolbar as a whole. Items keep `tabindex="-1"` except the active one (`tabindex="0"`). The hook returns a `RefCallback` — multiple containers can be registered simultaneously. Tracks the WAI-ARIA toolbar pattern. Requires `RovingTabIndexExtension` from `@lexical/a11y` in the editor's extension tree.

## Modal focus trap

`useLexicalFocusTrapRef` (`@lexical/react/useLexicalFocusTrapRef`) returns a `RefCallback` that cycles `Tab` / `Shift+Tab` inside a modal container, passing over descendants that don't take focus (hidden, `inert`, in a disabled `<fieldset>`, or a link inside an editor), and restores focus to the previously-focused element on deactivation. While active, the trap also installs a document-level `focusin` listener that pulls any focus landing outside the container back to the first descendant that takes focus (or the container itself) — so it recovers from the browser routing `Tab` out to its own chrome. Although several containers can be _registered_, only one trap should be _active_ at a time: concurrent traps install competing `focusin` listeners and fight over focus. Escape is **not** intercepted by the hook — modal owners handle the close key themselves, so the editor's Escape contract above stays predictable. Requires `FocusTrapExtension` from `@lexical/a11y` in the editor's extension tree.

## Screen reader announcements

`useLexicalAriaLiveRegion` (`@lexical/react/useLexicalAriaLiveRegion`) returns a stable `announce(message)` function. The hook itself mounts no DOM — like the others above, it is a thin adapter that **requires `AriaLiveRegionExtension` from `@lexical/a11y` in the editor's extension tree**. That extension owns the lifecycle of the visually-hidden region (`role="status"`, `aria-atomic`, `aria-live` defaulting to `polite` — configurable via its `politeness` config): the region is created in the extension's `register` step and disposed on the editor's teardown, not on the hook's unmount. `EditorModeAnnounceExtension` (mode transitions via `registerEditableListener`) and `HistoryAnnounceExtension` (undo / redo via `UNDO_COMMAND` / `REDO_COMMAND`) announce through the same region. Both extensions accept optional message overrides for i18n.

## Component ARIA quick reference

Where Lexical already applies ARIA attributes today (set in each component's `createDOM` / `updateDOM`, declaratively in the surrounding React tree, or applied imperatively via `setAttribute` on a managed or portaled element — as the typeahead menu and the live region do):

| Component | role | aria-\* attributes |
| --- | --- | --- |
| `ToolbarPlugin` (playground) | `toolbar` | `aria-label` |
| `Modal` (playground) | `dialog` | `aria-modal`, `aria-labelledby` |
| `LexicalListItemNode` (check list leaf) | `checkbox` | `aria-checked` |
| `LexicalMenu` typeahead popup | `listbox` | `aria-label` |
| Editor root (while typeahead is open) | — | `aria-controls`, `aria-activedescendant` |
| `EquationNode` (playground) | `math` | `aria-label` |
| `useLexicalAriaLiveRegion` region | `status` | `aria-live`, `aria-atomic` |

Custom nodes follow the same pattern: set the attributes in `createDOM` and re-apply in `updateDOM` when the state they reflect changes. There is no central ARIA contract on `LexicalNode`; treat each subclass's `createDOM` as the source of truth.

## Browser notes

Lexical relies on the standard DOM `Escape` contract — verified on Chrome and Safari (macOS, normal window). Safari in fullscreen intercepts `Escape` at the browser level to exit fullscreen; that is the browser's contract, not Lexical's.

## What this page does not cover

- Touch / mobile screen reader gestures. The hooks above share the same DOM contracts with mobile (TalkBack, VoiceOver iOS) but mobile has not been exercised in this set of changes.
- High contrast / forced-colors theming. See the playground's `index.css` `@media (forced-colors: active)` block for a baseline.
