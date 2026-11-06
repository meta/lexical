---
sidebar_label: Shadow DOM and iframes
---

# Shadow DOM and iframes

A Lexical editor works when its `contentEditable` lives inside an **open**
[DOM `ShadowRoot`](https://developer.mozilla.org/docs/Web/API/ShadowRoot) (for
example inside a [web component](https://developer.mozilla.org/docs/Web/API/Web_components))
or inside an `<iframe>` document. Both are supported out of the box — you only
have to point the editor at the right root element.

## Embedding in a shadow root

Attach an open shadow root, render a `contentEditable` inside it, and pass that
element to `editor.setRootElement` (or, with `@lexical/react`, portal the
`ContentEditable` into the shadow root — React context flows across the portal,
so the editor is built exactly as it would be in the light DOM):

```js
const host = document.querySelector('#editor-host');
const shadow = host.attachShadow({mode: 'open'});
const contentEditable = document.createElement('div');
contentEditable.contentEditable = 'true';
shadow.appendChild(contentEditable);

editor.setRootElement(contentEditable);
```

Lexical detects the enclosing shadow root from the root element and resolves
selection through it. There is nothing else to configure.

### Why it needs platform support

Inside a shadow tree the browser **retargets** the document's selection to the
shadow host: `Selection.anchorNode`/`focusNode` and `Selection.getRangeAt`
report the host element, not the node the caret is actually in, and
`document.activeElement` reports the host rather than the focused element.
Lexical works around this using only standard platform APIs:

- Selection is read with
  [`Selection.getComposedRanges`](https://developer.mozilla.org/docs/Web/API/Selection/getComposedRanges)
  and [`Selection.direction`](https://developer.mozilla.org/docs/Web/API/Selection/direction),
  which return the real (un‑retargeted) boundary points.
- Focus is read with
  [`ShadowRoot.activeElement`](https://developer.mozilla.org/docs/Web/API/DocumentOrShadowRoot/activeElement)
  via [`Node.getRootNode`](https://developer.mozilla.org/docs/Web/API/Node/getRootNode).
- Caret movement and word/line deletion use the native `Selection.modify`, and
  selection is written with `Selection.setBaseAndExtent`, both of which operate
  on shadow‑tree nodes directly.
- Drop targets and image-drag hit‑tests resolve through
  [`Document.caretPositionFromPoint`](https://developer.mozilla.org/docs/Web/API/Document/caretPositionFromPoint)
  with the `shadowRoots` option so the dropped point lands on the real node
  rather than the retargeted host.

### Browser support

The shadow-aware path requires the platform APIs listed above. Lexical falls
back to the light‑DOM reads when those APIs are missing, so editors that don't
live in a shadow tree keep working on any engine the rest of Lexical supports.

| Platform API | Used for | Chrome / Edge | Firefox | Safari |
| --- | --- | --- | --- | --- |
| `Selection.getComposedRanges` | Reading the un‑retargeted boundary points | 137+ | 142+ | 17.0+ |
| `Selection.direction` | Mapping the composed range back onto anchor/focus | 137+ | 126+ | 17.0+ |
| `ShadowRoot.activeElement` | Resolving the focused element through the host | All modern | All modern | All modern |
| `Document.caretPositionFromPoint({shadowRoots})` | Shadow-aware drop / drag hit-tests | 128+ | 125+ | 18.1+ |

Lexical also supports the legacy variadic form of `getComposedRanges` shipped by
Safari 17–18.1, automatically choosing the dictionary or variadic call shape
at runtime.

### Closed shadow roots

A closed shadow root (`{mode: 'closed'}`) hides its contents from outside code:
`Node.getRootNode({composed: false})` returns the host on every external probe,
and `Selection.getComposedRanges({shadowRoots})` ignores the closed root. The
editor inside a closed shadow root cannot read its own selection through the
host, so closed shadow roots are **not supported**.

If you need style/markup encapsulation without selection isolation, mount the
editor in an open shadow root with `delegatesFocus: true` instead — outside
code can still observe focus and selection while CSS and markup remain
encapsulated.

### Styling

Shadow trees do not inherit the document's stylesheets, so your editor/theme
CSS has to live inside the shadow root. A `<style>` element appended to the
root is the simplest option; a
[constructable stylesheet](https://developer.mozilla.org/docs/Web/API/CSSStyleSheet#constructor)
adopted via `shadowRoot.adoptedStyleSheets` scales better when one stylesheet
serves several editor instances. The playground's `ShadowDomWrapper` clones
the page's existing `<link>` / `<style>` nodes into the shadow root so it can
reuse Vite's HMR-managed stylesheets. This is a property of Shadow DOM, not
of Lexical.

CSS custom properties and inherited HTML attributes (`dir`, `lang`) cross
the shadow boundary on their own, so a page-level rule like `:root {
--editor-bg: #1c1d22; }` or a host attribute like `<my-editor dir="rtl"
lang="ko">` propagates into the editor without further setup. User
preference media queries (`@media (prefers-color-scheme: dark)`,
`(prefers-reduced-motion: reduce)`, `(forced-colors: active)`) evaluate
inside the shadow root just like outside; place them in the shadow-mounted
stylesheet rather than the page sheet.

## Embedding in an iframe

An editor whose root element belongs to an `<iframe>` document is also
supported. Lexical reads the editor's `window`/`document` from the root
element (`rootElement.ownerDocument.defaultView`), so selection and focus are
resolved against the iframe rather than the top‑level document:

```js
const iframeDoc = iframe.contentDocument;
const contentEditable = iframeDoc.querySelector('#editor');

// The editor can be built in the parent frame; once its root element is set it uses
// the iframe's own window and document for selection and focus.
editor.setRootElement(contentEditable);
```

Selection inside an iframe is **not** retargeted (an iframe is a separate
document, not a shadow boundary), so `getComposedRanges` is not involved here —
the iframe's own selection already reports the correct nodes.

## Shadow-aware helpers

If a plugin reads the DOM selection or the focused element directly, use the
shadow/iframe‑aware helpers exported from `lexical` instead of
`Selection.anchorNode` / `document.activeElement`, so it keeps working in these
contexts. In the plain light DOM each helper degrades to the standard read
without any extra cost.

| Instead of | Use |
| --- | --- |
| `Selection.anchorNode` / `anchorOffset` / `focusNode` / `focusOffset` | `getDOMSelectionPoints(selection, rootElement)` |
| `selection.getRangeAt(0)` | `getDOMSelectionRange(selection, rootElement)` |
| Both shapes from one read | `getDOMSelectionRangeAndPoints(selection, rootElement)` |
| `selection.getComposedRanges` raw call | `getComposedStaticRange(selection, rootElement)` |
| `document.activeElement === el` | `getActiveElement(el) === el` |
| Deepest focused element through nested shadow trees | `getActiveElementDeep(document)` |
| `event.target` on a `composed: true` event listening above the shadow boundary | `getComposedEventTarget(event)` |
| `node.getRootNode() instanceof ShadowRoot` (cross‑realm‑safe) | `isDOMShadowRoot(node)` |
| Walking up to discover enclosing shadow roots | `getDOMShadowRoots(node)` |

All nine helpers are marked `@experimental` while the surface stabilizes — the
return shape may change, but the behavior in the light DOM is stable.

### `getDOMSelectionPoints` read semantics

In the light DOM `getDOMSelectionPoints` returns the live `Selection` itself,
so each property read is deferred and `$updateDOMSelection` only pays for the
synchronous style/layout recalculation that a `Selection.anchorNode` /
`focusNode` read triggers when it actually needs the value. Inside a shadow
tree the return is a snapshot taken at call time, including
`Selection.direction` so callers can branch on it explicitly. Read the four
points immediately after the call rather than caching the returned reference,
or use `points === domSelection` to detect the alias path.

If a future engine ships `getComposedRanges` without `Selection.direction`
(no current configuration matches — every engine that ships the former
also ships the latter), the snapshot's `direction` is `undefined` and
anchor/focus default to the StaticRange's tree order; callers needing strict
backward fidelity should check `direction !== undefined` before relying on
the swap.

## Form association

A Lexical editor inside a [form-associated custom
element](https://developer.mozilla.org/docs/Web/API/Web_components#form-associated_custom_elements)
participates in a `<form>` like any built-in form control: submission carries
the editor's value, form reset clears it, and validation flows through. The
sketch:

```js
class LexicalEditorElement extends HTMLElement {
  static formAssociated = true;

  constructor() {
    super();
    this.internals = this.attachInternals();
  }

  get value() {
    return this.editor
      ? JSON.stringify(this.editor.getEditorState().toJSON())
      : '';
  }

  set value(serialized) {
    if (this.editor && serialized !== '') {
      this.editor.setEditorState(this.editor.parseEditorState(serialized));
    }
  }

  connectedCallback() {
    // `delegatesFocus: true` routes `host.focus()` (and implicit focus
    // from `<label for="...">`) to the first focusable element inside
    // the shadow root — for the editor that's the contentEditable.
    const shadow =
      this.shadowRoot ?? this.attachShadow({delegatesFocus: true, mode: 'open'});
    const contentEditable = document.createElement('div');
    contentEditable.contentEditable = 'true';
    contentEditable.tabIndex = 0;
    shadow.appendChild(contentEditable);

    const editor = buildEditorFromExtensions(
      defineExtension({name: 'lexical-editor-element'}),
    );
    editor.setRootElement(contentEditable);
    this.editor = editor;

    // Seed the form value so a submit before the user types still produces
    // a non-empty serialized state, mirroring `<input value="...">`.
    this.internals.setFormValue(this.value);

    editor.registerUpdateListener(({dirtyElements, dirtyLeaves}) => {
      // Only fire on real content changes, not on pure selection updates —
      // matches HTMLInputElement's `input` event contract.
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
      this.internals.setFormValue(this.value);
      this.dispatchEvent(new Event('input', {bubbles: true, composed: true}));
    });
  }
}
```

Without the dirty-leaf/element gate every caret move would wake the form's
`oninput` listeners, so the `input` event matches `HTMLInputElement`'s
contract only after that guard. The initial `setFormValue` is what keeps a
form submission before the user types from carrying an empty value, since
the update listener has not fired yet at that point. A full reference
implementation lives in
[`examples/shadow-dom-web-component`](https://github.com/meta/lexical/tree/main/examples/shadow-dom-web-component).

DOM moves (re-parenting the host into a different `<form>` or list) trigger
`disconnectedCallback` followed by `connectedCallback`, which rebuilds the
editor against a fresh contentEditable. Round-trip the user's content the
same way `<input>` and `<textarea>` round-trip their `value` attribute:
cache the serialized state in `disconnectedCallback` and replay it through
`parseEditorState` on the next mount. The reference dev example uses a
`pendingState` field for exactly this.

The same form-associated host can also implement the rest of the
[form-associated callbacks](https://developer.mozilla.org/docs/Web/API/Web_components/Using_custom_elements#form-associated_callbacks):
`formStateRestoreCallback(state, reason)` re-hydrates the editor on bfcache
navigation (`reason: 'restore'`) or form autocomplete restore
(`reason: 'autocomplete'`); `formAssociatedCallback(form)` reacts to
programmatic form moves; `formResetCallback()` clears the editor when the
surrounding form is reset; and `formDisabledCallback(isDisabled)` flips the
editor's editable state when an ancestor `<fieldset disabled>` toggles. The
serialized JSON `internals.setFormValue` published earlier is what comes
back in the state-restore callback.

## Common pitfalls

Moving an existing editor into a shadow root exposes a handful of recurring
mismatches between the DOM APIs you'd reach for and what they report.

### Event retargeting

Listeners above the shadow boundary — `window`, `document`'s
`selectionchange`, popups portaled to `document.body` — see `event.target`
retargeted to the shadow host, not the actual clicked element. A
`rootElement.contains(event.target)` gate therefore always rejects clicks
that came from the editor. Resolve through the composed path:

```js
const target = getComposedEventTarget(event);
if (target instanceof Node && rootElement.contains(target)) {
  // click really did land inside the shadow-hosted editor
}
```

### Focus probes

`document.activeElement` reports the host when focus is inside an open
shadow tree, so `document.activeElement === rootElement` is always false.
`getActiveElement(rootElement)` reads `DocumentOrShadowRoot.activeElement`
through `Node.getRootNode` instead, and `getActiveElementDeep` keeps
descending into nested shadow roots when an editor whose decorator embeds a
web component needs the innermost focused element.

```js
if (getActiveElement(rootElement) === rootElement) { ... }
```

### Outside-click handlers

A typical dropdown registers `document.addEventListener('click', ...)` and
calls `setShowDropDown(false)` whenever `button.contains(event.target)` is
false. From inside a shadow tree that check always fails (the target is the
host), so the dropdown closes on the very click that opened it. Compare
against `getComposedEventTarget(event)` instead — the same fix the playground's
`DropDown` and `@lexical/react`'s `DraggableBlockPlugin` use.

### Drop hit-tests

`document.caretRangeFromPoint` and the no-argument
`document.caretPositionFromPoint` return the host when the pointer is over
shadow content, so an image drop lands on the host rather than the textnode
under the cursor. `@lexical/clipboard`'s internal `caretFromPoint` helper switches to
`caretPositionFromPoint(x, y, {shadowRoots})` when `rootElement` lives in a
shadow tree, and verifies the returned offset node really did land inside
one of the requested shadow roots — engines that silently ignore the option
fall through to the legacy paths.

### Style mirror cleanup

If your shadow mount mirrors `<style>` / `<link>` nodes from `document.head`
and watches for additions via `MutationObserver`, mirror removals too;
otherwise stylesheets removed by HMR or a runtime theme swap linger inside
the shadow. `ShadowDomWrapper` tracks an `original → clone` map so an
upstream removal drops the corresponding clone, and on unmount it removes
every clone so React 18 StrictMode's double-mount can't accumulate
duplicates through the persistent shadow root.

Dev-mode HMR has two paths that a `childList`-only observer misses.
Firefox replaces a `<style>`'s text content in place, so the observer
needs `characterData + subtree` to see the mutation; Chrome and WebKit
update CSS through the CSSOM (`style.sheet.replaceSync` / `insertRule`),
which the DOM observer never sees at all. `ShadowDomWrapper` also
subscribes to Vite's `vite:afterUpdate` hook for an explicit resync of
every clone after each HMR pass — `import.meta.hot` is `undefined` in
production builds, so the hook is a no-op outside dev.

### Popover and dialog layout

The UA stylesheet defaults a closed
[Popover](https://developer.mozilla.org/docs/Web/API/Popover_API) (or a
`<dialog>` without `open`) to `display: none`. A base rule like
`#my-popover { display: flex; ... }` overrides that and leaves the popover
visible after `hidePopover()`. Scope layout to the open state instead —
`#my-popover:popover-open { display: flex; }` — so the closed state honors
the UA default. This is a popover-API gotcha, not a shadow-specific one,
but it surfaces here because floating UI anchored to a shadow-root
selection (a format popover or link editor that reads coordinates through
`getDOMSelectionRangeAndPoints`) is a common shadow integration pattern.

### Observers across the shadow boundary

`ResizeObserver`, `IntersectionObserver`, and `MutationObserver` observe
nodes inside an open shadow root with no special configuration — pass the
inner node (the contentEditable or the host) just like any other DOM
target. A `MutationObserver` registered on the host does not see mutations
inside the shadow tree, though; observe the contentEditable or a
shadow-internal container instead. The host's `attributeChangedCallback`
covers the host's own attribute changes.

## Migrating an existing light-DOM editor

The same code shape keeps working in a shadow root; migration is mostly
about removing pre-shadow workarounds. Direct selection reads
(`Selection.anchorNode`, `Selection.getRangeAt(0)`,
`document.querySelector('[contenteditable]')` used as an editor probe) route
through `getDOMSelectionPoints` / `getDOMSelectionRange` /
`getActiveElement`, and any `event.target` read above the shadow boundary
becomes `getComposedEventTarget(event)`. CSS variables inherit through the
shadow boundary but class declarations don't, so the editor/theme CSS has
to be adopted or cloned into the shadow root.

The focus and popup paths are the ones that surprise people in review:
outside-click handlers, blur-then-refocus, and "did the editor lose focus?"
probes usually need `getActiveElement(rootElement)` rather than
`document.activeElement`; floating UI that portals into `document.body` and
resolves hover with `element.getRootNode().elementFromPoint(x, y)` keeps the
same call shape but has to guard the popup root narrowing against a
detached popup whose `getRootNode()` returns itself.

## Examples

Runnable examples live in the repository:

- [`examples/shadow-dom`](https://github.com/meta/lexical/tree/main/examples/shadow-dom)
  — a React editor inside a shadow root with a light‑DOM toolbar.
- [`examples/shadow-dom-web-component`](https://github.com/meta/lexical/tree/main/examples/shadow-dom-web-component)
  — a framework‑free `<lexical-editor>` custom element, form‑associated via
  `ElementInternals`. The page also mounts one instance inside a wrapper
  `<div>` that opens its own shadow root, exercising the multi‑level
  walk through two nested shadow boundaries.
- [`examples/vanilla-js-iframe`](https://github.com/meta/lexical/tree/main/examples/vanilla-js-iframe)
  — an editor rendered into an `<iframe>`.
- The playground's **Render in Shadow DOM** setting toggles the same editor
  between light and shadow mounts, useful for spot-checking your plugins
  against both modes.