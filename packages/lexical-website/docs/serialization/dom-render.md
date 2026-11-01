# DOMRenderExtension

:::warning Experimental

`DOMRenderExtension` and everything described on this page are marked
`@experimental` and may change between any two Lexical releases —
including breaking renames, signature changes, or behavior changes —
until the API stabilizes. We track issues and proposals in the
[GitHub repo](https://github.com/meta/lexical); breaking changes
will be called out in release notes. Apps that depend on this
extension should pin their Lexical version and treat upgrades as
intentional.

The legacy on-class `createDOM` / `updateDOM` / `exportDOM` and the
default `$generateHtmlFromNodes` entry are unchanged and remain the
supported default for production apps that don't want to track an
experimental API.

The DOMRenderExtension API was introduced in Lexical v0.44.0,
with significant additions in v0.45.0

:::

`DOMRenderExtension` lets you override how Lexical nodes are rendered
to the DOM during reconciliation (the `createDOM` / `updateDOM` /
`decorateDOM` cycle) and how they're serialized to HTML for clipboard
export and `$generateHtmlFromNodes`. Both paths are configured in the
same extension, but they run different hooks: `$exportDOM` only runs
for export, `$updateDOM` and `$decorateDOM` only run during
reconciliation, and `$createDOM` reaches export only through a node's
default `exportDOM` (see the tip under [Quick start](#quick-start)).

For the inverse direction — converting a DOM tree into Lexical nodes
— see [DOMImportExtension](./dom-import.md).

## When to use it

You want `DOMRenderExtension` instead of subclassing or
`registerMutationListener` whenever the change is **how a node
becomes DOM**:

- Tagging every rendered element with a state-driven attribute (e.g.
  `data-id`, `data-color`).
- Adding an extra wrapping element around a specific node type's
  children without subclassing.
- Stripping or rewriting attributes during HTML export (e.g. removing
  the `white-space: pre-wrap` style when a TextNode doesn't need it).
- Customizing the root element returned by `$generateDOMFromRoot`.
- Branching export behavior on whether this is a clipboard copy vs. a
  full-document serialization.

The render and export overrides are middleware-shaped — each one
calls `$next()` to get the default (or lower-priority) result and
returns its own. This composes cleanly across extensions: each
extension declares its overrides without coordinating with the
others.

## Quick start

```ts
import {
  buildEditorFromExtensions,
  configExtension,
} from '@lexical/extension';
import {DOMRenderExtension, domOverride} from '@lexical/html';
import {defineExtension, isHTMLElement, TextNode} from 'lexical';

const editor = buildEditorFromExtensions(
  defineExtension({
    name: 'app',
    dependencies: [
      configExtension(DOMRenderExtension, {
        overrides: [
          domOverride([TextNode], {
            $createDOM(node, $next, editor) {
              const dom = $next();
              dom.setAttribute('data-fluid', 'true');
              return dom;
            },
          }),
        ],
      }),
    ],
  }),
);
```

The override above tags every rendered TextNode with
`data-fluid="true"`. It composes with whatever else
`DOMRenderExtension` is configured to do for `TextNode` — both inside
the editor and during HTML export.

:::tip

The default `LexicalNode.exportDOM` calls the editor's configured
`$createDOM` hook. A `$createDOM` override therefore also affects HTML
export for nodes that inherit this method or call `super.exportDOM(editor)`,
including `TextNode`. A custom `exportDOM` implementation that creates its
own element can bypass it. Use `$exportDOM` for export-specific changes;
`$updateDOM` and `$decorateDOM` only run during reconciliation.

:::

## Overrides

An override is a `DOMRenderMatch<T>` built with `domOverride`. It
targets a set of node classes (or `'*'`) and supplies any subset of
the following middleware methods:

| Override | When it's called | Replaces / wraps |
| --- | --- | --- |
| `$createDOM` | Reconciler creates DOM, or the default `LexicalNode.exportDOM` creates an export element | `node.createDOM` |
| `$updateDOM` | Reconciler updates an existing DOM node | `node.updateDOM` |
| `$decorateDOM` | After create or update, after children reconcile | (additive — no default to replace) |
| `$getDOMSlot` | Reconciler asks "where do children attach?" for an `ElementNode` | `ElementNode.getDOMSlot` |
| `$exportDOM` | Building HTML for clipboard or `$generateHtmlFromNodes` | `node.exportDOM` |
| `$shouldExclude` | Decide whether to omit a node from HTML | `ElementNode.excludeFromCopy` |
| `$shouldInclude` | Decide whether to include a node in HTML, typically based on selection | The default `selection ? node.isSelected(selection) : true` |
| `$extractWithChild` | Include a node because one of its children is selected, even if it wouldn't otherwise be included | `node.extractWithChild` |

All except `$decorateDOM` are `$next()`-style middleware. Calling
`$next()` returns the default (or lower-priority override) value; you
can use it as-is, transform it, or replace it.

:::warning

`$decorateDOM` is the exception: it has no `$next` argument. All
applicable `$decorateDOM` functions are called unconditionally, and
the ordering is equivalent to an implicit `$next` call FIRST — lower-
priority handlers run before higher-priority ones. Use it for in-place
DOM tweaks (setting attributes, applying state-driven styles) where
you always want to layer on top of what others have already done.

:::

`domOverride` also accepts an optional third `options` argument to install
an override only under certain conditions — see
[Conditional overrides](#conditional-overrides).

### Matching nodes

`domOverride` takes either `'*'` (matches every node) or an array of
`NodeMatch<T>` entries — each entry is either a node `Klass` (e.g.
`TextNode`, `ParagraphNode`) or a `$isNodeGuard` predicate.

```ts
// Apply to all nodes
domOverride('*', { $decorateDOM(node, _, dom) { /* … */ } });

// Apply to TextNode and its subclasses (the Klass form covers subclasses)
domOverride([TextNode], { $createDOM(node, $next) { /* … */ } });

// Apply to a custom guard
domOverride([$isQuoteNode], { $exportDOM(node, $next) { /* … */ } });
```

:::tip

Using the `Klass` form is significantly cheaper than a guard
function — the dispatcher can compile class-based matches into a
direct lookup keyed by node type. Reserve `$isNodeGuard` for cases
where the same DOM behavior should apply to a structurally identified
set of nodes that don't share a common ancestor class.

:::

### Priority

The relative priority of two overrides is determined by:

1. **Wildcards (`'*'`) have highest priority** — they wrap everything.
2. **Predicates** (`$isParagraphNode`) come next.
3. **Subclasses before parents** — an override for `ParagraphNode`
   runs before one for `ElementNode`.
4. **Extensions closer to the root run earlier** — apps wrap
   library overrides.
5. **Extensions depended on later run earlier** — when two
   extensions are at the same depth, the one merged later wins.
6. **Overrides defined later in the same array** — the last entry of
   a `configExtension(DOMRenderExtension, {overrides: […]})` array
   runs first.

`$next()` walks DOWN this priority chain — your override runs first,
then the next-lower override (or eventually the node's default
implementation).

### Writing read-only

The overrides are called during reconciliation and export, both of
which are READ-ONLY contexts. Don't call `editor.update()` or mutate
node state from inside an override — Lexical is in the middle of
producing the DOM for the state it already has. Use a node transform
or update listener if you need to react to changes.

## Worked examples

### State-driven attribute on every node

A common pattern: every node carries some app-defined state (e.g. a
unique `id` from NodeState) and you want it surfaced as a DOM
attribute in both the editor and the HTML export.

```ts
import {createState, $getState, $setState, $getStateChange} from 'lexical';
import {DOMRenderExtension, domOverride} from '@lexical/html';

const idState = createState('id', {
  parse: (v) => (typeof v === 'string' ? v : null),
});

configExtension(DOMRenderExtension, {
  overrides: [
    domOverride('*', {
      $createDOM(node, $next) {
        const dom = $next();
        const id = $getState(node, idState);
        if (id) {
          dom.setAttribute('id', id);
        }
        return dom;
      },
      $updateDOM(nextNode, prevNode, dom, $next) {
        if ($next()) {
          // Lower-priority override requested re-mount; nothing more for us to do
          return true;
        }
        const change = $getStateChange(nextNode, prevNode, idState);
        if (change) {
          const [id] = change;
          if (id) {
            dom.setAttribute('id', id);
          } else {
            dom.removeAttribute('id');
          }
        }
        return false;
      },
    }),
  ],
});
```

The `id` reaches HTML export through `$createDOM` only for nodes that use
the default `exportDOM`. For a node class whose `exportDOM` builds its own
element, add a `$exportDOM` override that sets it as well.

Note the `$updateDOM` shape: it returns `true` to tell the reconciler
to unmount and re-create the DOM (e.g. when the element tag would
change), or `false` after performing an in-place update. Calling
`$next()` lets a lower-priority handler signal the re-mount.

### Customizing the slot for an ElementNode

`$getDOMSlot` controls where child nodes attach in the DOM. The
result of `$next()` is the default `ElementDOMSlot` returned by
`ElementNode.getDOMSlot`; you can re-derive a new one to insert an
extra wrapping element while the root createDOM returns one
HTMLElement:

```ts
domOverride([SectionNode], {
  $createDOM(node, $next) {
    const root = $next();
    const wrapper = document.createElement('div');
    wrapper.className = 'section-inner';
    root.appendChild(wrapper);
    return root;
  },
  $getDOMSlot(node, dom, $next) {
    // Children go into .section-inner, not directly in the root <section>
    const inner = dom.querySelector('.section-inner');
    return $next().withElement(inner as HTMLElement);
  },
});
```

### Adjusting HTML export

`$exportDOM` returns a `DOMExportOutput` (`{element, after?, append?, $getChildNodes?}`).
Override it to strip unwanted attributes or rewrite the output for
clipboard / `$generateHtmlFromNodes`:

```ts
domOverride([TextNode], {
  $exportDOM(_node, $next) {
    const result = $next();
    if (isHTMLElement(result.element)) {
      // Drop white-space: pre-wrap when not needed
      const textContent = result.element.textContent || '';
      if (
        result.element.style.whiteSpace === 'pre-wrap' &&
        !/^\s|\s$|\s\s/.test(textContent)
      ) {
        result.element.style.removeProperty('white-space');
        if (result.element.getAttribute('style')?.trim() === '') {
          result.element.removeAttribute('style');
        }
      }
    }
    return result;
  },
});
```

### Selection-aware export filters

`$shouldExclude`, `$shouldInclude`, and `$extractWithChild` together
control which nodes appear in the HTML output, particularly when a
selection is in play. They run in this precedence order (highest to
lowest):

1. `$shouldExclude` returns `true` ⇒ the node is omitted (and if it's
   an ElementNode, its children may still be hoisted in its place).
2. `$shouldInclude` returns `true` ⇒ include the node.
3. `$extractWithChild` returns `true` for any of its children ⇒
   include the node so the included child has its proper wrapper
   (e.g. a `ListNode` when one of its `ListItemNode`s is selected).

```ts
domOverride([CommentMarkNode], {
  // Never include comment marks in exported HTML, but keep their children.
  $shouldExclude: () => true,
});
```

## Render context

Some overrides need to know "is this an export or an editor render?"
or "is this the root call from `$generateDOMFromRoot`?". Use the
render context for that.

### `createRenderState`

Mint a typed context key with `createRenderState`:

```ts
import {createRenderState} from '@lexical/html';

// True if this serialization is heading to the clipboard (vs. an
// editor reconciliation).
const ClipboardCopyState = createRenderState('clipboardCopy', Boolean);
```

Read it inside an override via `$getRenderContextValue`:

```ts
import {$getRenderContextValue} from '@lexical/html';

domOverride([TableNode], {
  $exportDOM(node, $next, editor) {
    const result = $next();
    if ($getRenderContextValue(ClipboardCopyState, editor)) {
      // Strip editor-only data-* attributes for cleaner clipboard HTML
      // …
    }
    return result;
  },
});
```

Layer values for an entire render call via
`DOMRenderConfig.contextDefaults`:

```ts
configExtension(DOMRenderExtension, {
  contextDefaults: [
    contextValue(ClipboardCopyState, false),
  ],
  overrides: [/* … */],
})
```

Or for a single call via `$withRenderContext`:

```ts
import {$withRenderContext, contextValue} from '@lexical/html';

const html = $withRenderContext(
  [contextValue(ClipboardCopyState, true)],
  editor,
)(() => $generateHtmlFromNodes(editor, selection));
```

For a value that should **persist on the editor** rather than scope to a
single callback, set it imperatively with `$setRenderContextValue` (or
`$updateRenderContextValue` for an updater). This is the editor-scoped,
persistent counterpart to `$withRenderContext`, and it's what drives
[conditional overrides](#conditional-overrides): a write that changes a value
read by a `disabledForEditor` predicate recompiles the render config and
re-renders the affected nodes.

### Built-in render states

`@lexical/html` ships two render states out of the box:

- **`RenderContextExport`** — `true` while serializing to HTML
  (`$generateDOMFromNodes`, `$generateDOMFromRoot`,
  `$generateHtmlFromNodes`). Use this to branch behavior between the
  in-editor render and an HTML export.
- **`RenderContextRoot`** — `true` only during the outermost
  `$generateDOMFromRoot` call (i.e. when the root node itself is
  being serialized as a `<div role="textbox">` wrapper). Useful when
  the root node should appear differently in a full-document export
  than as a child of some other element.

## Conditional overrides

By default every override is always installed. Pass an optional third
`options` argument to `domOverride` to install an override only under certain
conditions, decided purely from the [render context](#render-context):

```ts
domOverride(nodes, config, {
  // Install in the editor's render pipeline (reconciliation + the base for
  // export) only when this returns false. Default: always installed.
  disabledForEditor?: (ctx) => boolean,
  // Participate in a single export/generate session only when this returns
  // false. Default: always participates.
  disabledForSession?: (ctx) => boolean,
});
```

Each predicate receives a read-only view of the render context
(`ctx.get(state)`) and decides *whether the override exists*, rather than
running on every node and bailing out internally.

### `disabledForEditor` — runtime toggles

`disabledForEditor` reads the **persistent editor context** and gates whether
the override is part of the editor's compiled render config. Since the
in-editor render path uses that config, this is the scope that controls live
reconciliation.

Toggle it with `$setRenderContextValue` (see
[Render context](#render-context)). When a write flips the predicate's result,
the config is recompiled and the affected nodes are re-rendered — recreating
their DOM, since an override that produced or decorated an element can only be
undone by a fresh `createDOM`.

```ts
import {
  $setRenderContextValue,
  createRenderState,
  domOverride,
  DOMRenderExtension,
} from '@lexical/html';
import {LineBreakNode} from 'lexical';

const LineBreakWrapDisabled = createRenderState(
  'lineBreakWrapDisabled',
  () => false,
);

configExtension(DOMRenderExtension, {
  overrides: [
    domOverride(
      [LineBreakNode],
      {
        $createDOM(node, $next) {
          const wrapper = document.createElement('span');
          wrapper.className = 'visible-non-printing-linebreak';
          wrapper.appendChild($next());
          return wrapper;
        },
        // … $getDOMSlot to expose the inner <br>, $updateDOM to recreate when
        // the wrap state changes …
      },
      {disabledForEditor: (ctx) => ctx.get(LineBreakWrapDisabled)},
    ),
  ],
});

// Later — e.g. from a settings change. The override is removed from the
// pipeline entirely when disabled (no per-node checks remain), and existing
// line breaks re-render without the wrapper.
$setRenderContextValue(LineBreakWrapDisabled, true, editor);
```

Because the override isn't in the dispatch chain at all when disabled, there's
no per-node cost — the advantage over checking a flag inside the hook.

### `disabledForSession` — per-export gating

`disabledForSession` is evaluated once at the start of each export/generate
session (`$generateHtmlFromNodes`, `$generateDOMFromNodes`,
`$generateDOMFromRoot`) against that session's context. It controls whether the
override participates in *that walk only*, and has **no effect on live
reconciliation** — reconciliation isn't a session, so there's nothing for the
predicate to read.

This suits export transforms you only want for certain serializations (e.g. a
"terse" copy) without paying for the middleware on every export:

```ts
const TerseExport = createRenderState('terseExport', () => false);

configExtension(DOMRenderExtension, {
  overrides: [
    domOverride(
      '*',
      {
        $exportDOM(node, $next) {
          const result = $next();
          // … strip theme classes / unneeded styles …
          return result;
        },
      },
      {disabledForSession: (ctx) => !ctx.get(TerseExport)},
    ),
  ],
});

// A normal export skips the override entirely…
const html = editor.read(() => $generateHtmlFromNodes(editor));

// …while a terse export opts in for that one walk:
const terseHtml = editor.read(() =>
  $withRenderContext([contextValue(TerseExport, true)], editor)(() =>
    $generateHtmlFromNodes(editor),
  ),
);
```

### Choosing a scope

| You want to… | Use |
| --- | --- |
| Turn a render behavior on/off for the whole editor at runtime | `disabledForEditor` + `$setRenderContextValue` |
| Include an export transform only for certain serializations | `disabledForSession` + `$withRenderContext` |
| Branch behavior inside an always-installed override | read the context with `$getRenderContextValue` (no options needed) |

## Entry points

Three top-level helpers consume the configured overrides:

| Function | Purpose |
| --- | --- |
| `$generateDOMFromNodes(container, selection?, editor?)` | Walks `RootNode.getChildren()` and appends each to `container`. Sets `RenderContextExport=true`. |
| `$generateDOMFromRoot(container, root?)` | Like the above but includes the root node itself (wrapped in a `<div role="textbox">` by default). Sets `RenderContextExport=true` and `RenderContextRoot=true`. |
| `$generateHtmlFromNodes(editor, selection?)` | Convenience: creates a `<div>`, calls `$generateDOMFromNodes`, returns its `innerHTML`. |

All three are read-only (use them inside `editor.read()` or alongside
your own `editor.update()`).

## Capabilities

Current:

- Override `createDOM`, `updateDOM`, `decorateDOM`, `getDOMSlot`,
  `exportDOM`, `shouldExclude`, `shouldInclude`, `extractWithChild`
  per node class or globally.
- Middleware `$next()` chain composes across extensions.
- Typed render context (`createRenderState`, `RenderContextExport`,
  `RenderContextRoot`) lets overrides branch on the calling mode.
- One extension declares both in-editor rendering and HTML export
  overrides. A `$createDOM` override also reaches export through the
  default `exportDOM`; `$updateDOM` and `$decorateDOM` only run during
  reconciliation.
- Conditional installation via `disabledForEditor` / `disabledForSession`,
  with imperative `$setRenderContextValue` / `$updateRenderContextValue` to
  toggle editor-scoped overrides at runtime.

Future:

- The legacy `node.createDOM` / `node.updateDOM` / `node.exportDOM`
  on each node class continues to work side-by-side; nothing in this
  iteration flips the default. Extensions opt-in to the override
  pipeline, and the resulting overrides supersede the on-class
  defaults for matching nodes.
