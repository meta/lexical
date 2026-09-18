# DOMImportExtension

:::warning Experimental

`DOMImportExtension` and everything described on this page are marked
`@experimental` and may change between any two Lexical releases —
including breaking renames, signature changes, or behavior changes —
until the API stabilizes. We track issues and proposals in the
[GitHub repo](https://github.com/facebook/lexical); breaking changes
will be called out in release notes. Apps that depend on this
pipeline should pin their Lexical version and treat upgrades as
intentional.

The legacy static `importDOM` machinery and `$generateNodesFromDOM`
entry are unchanged and remain the supported default for production
apps that don't want to track an experimental API.

The DOMImportExtension API was introduced in Lexical v0.45.0

:::

The DOM import system in `@lexical/html` lets you convert any HTML or
DOM tree into Lexical nodes. The legacy entry — the static
`importDOM` declared on each node class — still works, but for new
code we offer an extension-based pipeline (`DOMImportExtension`) with
typed selectors, middleware-style rules, structural schemas,
configurable whitespace handling, and a dedicated context system. It's
designed for performance, ergonomics, and composability across
extensions.

The new pipeline ships side-by-side with the legacy one in
`@lexical/html`; the default `$generateNodesFromDOM` is unchanged. The
node-providing extensions (`RichTextExtension`, `ListExtension`,
`LinkExtension`, `TableExtension`, `CodeExtension`, …) register their
own import rules (plus the shared `CoreImportExtension` baseline), so
an editor built from them already has a fully configured
`DOMImportExtension` — to opt in, just read the imported nodes from
the extension's `$generateNodesFromDOM` output (or add
`ClipboardDOMImportExtension` to route pastes through it).

## Quick start

The smallest editor that imports HTML through the extension pipeline:

```ts
import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {
  CoreImportExtension,
  DOMImportExtension,
} from '@lexical/html';
import {$getRoot, defineExtension} from 'lexical';

const editor = buildEditorFromExtensions(
  defineExtension({
    name: 'app',
    dependencies: [CoreImportExtension],
  }),
);

const dep = getExtensionDependencyFromEditor(editor, DOMImportExtension);
editor.update(() => {
  const dom = new DOMParser().parseFromString(
    '<p>Hello <strong>world</strong></p>',
    'text/html',
  );
  const nodes = dep.output.$generateNodesFromDOM(dom);
  $getRoot().clear().splice(0, 0, nodes);
});
```

`CoreImportExtension` ships the rules that cover `<p>`, `<span>`,
inline format tags (`<b>`, `<strong>`, `<em>`, `<i>`, `<code>`,
`<mark>`, `<s>`, `<sub>`, `<sup>`, `<u>`), `<br>`, and `#text` —
everything the core lexical package's legacy `importDOM` machinery
handled — plus `<hr>`, gated on `HorizontalRuleNode` being registered
(the node lives in `@lexical/extension`, which is upstream of
`@lexical/html` and so cannot register import rules itself).

The per-tag rules ship with the extensions that provide the nodes, so
listing the node extensions you want is the entire import
configuration:

| Extension | Provides |
| --- | --- |
| `CoreImportExtension` (`@lexical/html`) | `<p>`, `<span>`, inline format tags, `<br>`, `#text`, `<hr>` (when `HorizontalRuleNode` is registered) |
| `RichTextExtension` (`@lexical/rich-text`) | `<h1>`–`<h6>`, `<blockquote>`, Google Docs 26pt-title heuristic |
| `ListExtension` (`@lexical/list`) | `<ol>`, `<ul>` (incl. checklist detection), `<li>`, GitHub task list, Joplin checkbox |
| `LinkExtension` (`@lexical/link`) | `<a>` |
| `TableExtension` (`@lexical/table`) | `<table>`, `<tr>`, `<td>`, `<th>` |
| `CodeExtension` (`@lexical/code-core`) | `<pre>`, multi-line `<code>`, monospace `<div>`, GitHub raw-file-view tables |

Each of these depends on `CoreImportExtension` itself, so the shared
baseline comes along automatically. The rules are inert unless the
editor actually routes HTML through the pipeline (the legacy paste
path is unchanged), and an extension's rules merge above its
dependencies' rules, so app-registered rules still win dispatch.

The standalone `RichTextImportExtension` / `ListImportExtension` /
`LinkImportExtension` / `TableImportExtension` / `CodeImportExtension`
/ `HorizontalRuleImportExtension` bundles from earlier versions still
exist as deprecated aliases for the corresponding runtime extensions.

:::tip

The legacy entry `$generateNodesFromDOM(editor, dom)` and the new
extension's `dep.output.$generateNodesFromDOM(dom)` both live in
`@lexical/html`. Tell them apart by signature: the legacy takes the
editor first, the new one takes only the DOM (plus optional
`{context, preprocess}`).

:::

## Rules

A rule is the unit of work in the extension. Each rule is built with
`defineImportRule`:

```ts
import {defineImportRule, sel} from '@lexical/html';
import {$createParagraphNode} from 'lexical';

const ParagraphRule = defineImportRule({
  name: '@app/p',
  match: sel.tag('p'),
  $import: (ctx, el) => {
    const p = $createParagraphNode();
    p.splice(0, 0, ctx.$importChildren(el));
    return [p];
  },
});
```

A rule has three parts:

1. **`match`** — an opaque `CompiledSelector` produced by `sel.*`. The
   dispatcher buckets rules by tag at compile time so the per-node
   dispatch cost is bounded by the number of rules registered for
   that tag (typically one or two).
2. **`$import`** — middleware-style function `(ctx, node, $next) =>
   readonly LexicalNode[]`. The element type of `node` is narrowed by
   the selector (e.g. `sel.tag('a')` gives `HTMLAnchorElement`,
   `sel.text()` gives `Text`). Return `[]` to drop the element, or
   call `$next()` to defer to the next-lower matching rule.
3. **`name`** (optional) — surfaces in dev-mode warnings and error
   traces. Convention: `'@scope/package/rule-id'`.

### Dispatch order

There is no numeric priority. `DOMImportConfig.rules` is a single flat,
ordered list, and dispatch walks it **front to back**: for a given DOM
node the dispatcher visits each rule whose `match` accepts that node, in
list order, and the first rule that returns without calling `$next()`
decides the outcome. "Higher priority" and "earlier in the list" are the
same thing.

So within one `configExtension(DOMImportExtension, {rules})` call, the
rules run in the order you wrote them:

```ts
configExtension(DOMImportExtension, {
  rules: [
    // Tries this first
    SpecificParagraphRule,
    // Falls back to this via $next()
    GenericParagraphRule,
  ],
})
```

Calling `$next()` from a rule walks the chain — the next matching rule
in the list fires; if none is left, the framework's catch-all
`DefaultHoistRule` descends into the element's children. Returning `[]`
from a rule short-circuits: nothing else runs and the element is
dropped.

#### How the list is assembled

Many extensions contribute to the same list. `DOMImportExtension`'s
`mergeConfig` **prepends** each contribution to what has accumulated so
far, and the extension builder merges configs in dependency order — a
dependency's contribution is merged before the contribution of the
extension that depends on it. Two consequences:

- **Each contribution stays contiguous and keeps its own order.** Your
  `rules` array is inlined as one chunk, first entry first. Ordering
  *within* your own rules is entirely up to you.
- **The chunks run most-dependent first.** An extension's rules are
  tried before the rules contributed by its dependencies. That is what
  makes overriding work: `@lexical/rich-text` depends on
  `CoreImportExtension`, so its `<p>` rule is reached before the core
  one, and an app extension that depends on `@lexical/rich-text` gets to
  go ahead of both.

Concretely, for an app extension that depends on `RichTextExtension`
(which in turn depends on `CoreImportExtension`), the compiled list is:

```
[ …rules passed to buildEditorFromExtensions… ]  ← merged last, highest priority
[ …the app extension's rules…                 ]
[ …@lexical/rich-text's rules…                ]
[ …CoreImportExtension's rules…               ]
[ DefaultHoistRule                            ]  ← the base config, always last
```

Configuration handed straight to `buildEditorFromExtensions` is merged
after every extension's, so it outranks all of them. `DefaultHoistRule`
is `DOMImportExtension`'s own default `config.rules` entry, so
everything else lands in front of it and it is always the last rule
tried.

:::caution

The relative order of two extensions where neither transitively depends
on the other falls out of the topological sort and is not part of the
API. If extension **A** must override a rule from extension **B**, say
so structurally — make **B** a dependency of **A** — rather than relying
on the order they happen to be listed in.

:::

### `$next()` as a wrapper

The middleware shape is strictly more powerful than the legacy
numeric `priority`. A rule can call `$next()`, inspect the result,
and transform it — perfect for cross-cutting decorators:

```ts
const IdAttributeRule = defineImportRule({
  name: '@app/id-decorator',
  match: sel.any().attr('id', /\S/),
  $import: (ctx, el, $next) => {
    const out = $next();
    if (out.length === 1) {
      $setState(out[0], idState, el.getAttribute('id')!);
    }
    return out;
  },
});
```

Placed early in your `rules` array, this rule fires for every element
carrying an `id` BEFORE the tag-specific rule, calls `$next()` to get
the produced node, and tags it with state. No tag-specific machinery
needs to know about `id`.

## Selectors

Build selectors with the combinator API:

```ts
sel.any()                                       // any HTMLElement
sel.tag('a')                                    // <a> only (typed as HTMLAnchorElement)
sel.tag('h1', 'h2', 'h3', 'h4', 'h5', 'h6')     // typed as HTMLHeadingElement
sel.text()                                      // text nodes
sel.comment()                                   // comment nodes
sel.tag('li').classAll('task-list-item')        // <li class="task-list-item …">
sel.tag('span').classAny('hl', 'mark')          // <span class="hl|mark …">
sel.tag('a').attr('href', /^https:/)            // <a href> matching a regex
sel.tag('a').attr('target', 'true')             // attribute present
sel.tag('a').attr('href', '/wiki')              // exact value
sel.tag('span').styleAny('fontSize', /^(\d+)pt/) // inline-style match
```

A CSS-subset parser is also available for terse selectors:

```ts
sel.css('p.google-docs-title')      // tag + class
sel.css('h1, h2, h3, h4, h5, h6')   // tag list
sel.css('img[src]')                 // attribute presence
sel.css('a[href="/wiki"]')          // attribute equality
```

`sel.css` covers the basics (tag, `.class`, `#id`, `[attr]`,
`[attr="val"]`, comma-separated lists, `*`). For anything outside that
subset (regex attribute, inline-style match, capturing), chain
combinator methods off the result:

```ts
sel.css('pre').attr('class', /(?:^|\s)language-(\S+)/, {capture: 'lang'})
```

The grammar deliberately excludes descendant combinators (`>`, ` `)
and `:not` — see [Context](#context) below for the idiomatic
replacements.

### Captured matches

Pass `{capture: 'name'}` to `attr` or `styleAny` and the
`RegExpMatchArray` for the successful match is surfaced on
`ctx.captures.name`, fully typed:

```ts
const CodeBlockRule = defineImportRule({
  name: '@app/pre-code',
  match: sel
    .tag('pre')
    .attr('class', /(?:^|\s)language-(\S+)/, {capture: 'lang'}),
  $import: (ctx, el) => {
    // ctx.captures.lang: RegExpMatchArray
    const language = ctx.captures.lang[1];
    const node = $createCodeNode(language);
    node.splice(0, 0, ctx.$importChildren(el));
    return [node];
  },
});
```

The selector's element type and captures map both flow into `$import`'s
signature, so you never need to cast `el` or re-run the regex inside
the rule body.

:::tip

If your selector becomes a runtime function (a `(node) => boolean`
guard), the rule lands in the wildcard bucket and is consulted for
every element — expensive. Push as much as possible into the selector
itself; do the remaining refinement inside the rule body, calling
`$next()` to defer when the body decides not to handle the element.

```ts
defineImportRule({
  match: sel.tag('img'),  // tag bucket — cheap
  $import: (ctx, el, $next) => {
    if (!el.src || el.src.startsWith('data:')) {
      return $next();      // body refinement
    }
    return [$createImageNode({src: el.src, alt: el.alt})];
  },
});
```

:::

## Schemas

A rule's `$import` body uses `ctx.$importChildren(parent, {schema})`
to recursively import children. The schema enforces what node types
are allowed in this position and how to package non-conforming runs:

```ts
interface ChildSchema {
  $accepts(child: LexicalNode, parent: LexicalNode | null): boolean;
  $packageRun?(rejected: LexicalNode[], ...): LexicalNode[];
  onReject?: 'hoist' | 'drop';
  $finalize?(children: LexicalNode[], ...): LexicalNode[];
}
```

The `$`-prefixed members are invoked inside the import walk (which
already runs inside `editor.update`), so they can call `$is*`
predicates and node methods on the `LexicalNode` arguments directly.

Built-ins, all from `@lexical/html`:

| Schema | Accepts | Rejected runs |
| --- | --- | --- |
| `BlockSchema` | Block ElementNodes and block DecoratorNodes | Wrapped in a fresh `ParagraphNode` (preserves `text-align`) |
| `RootSchema` | Same as `BlockSchema` — aliased for clarity at the entry point | Same |
| `InlineSchema` | Inline ElementNodes, TextNodes, inline DecoratorNodes | Dropped |
| `NestedBlockSchema` | Block nodes | Inline runs pass through unchanged (no extra paragraph wrapping) |

Per-package schemas:

| Schema | Accepts | Rejected runs |
| --- | --- | --- |
| `ListSchema` (`@lexical/list`) | `ListItemNode`, nested `ListNode` | Wrapped in a synthetic `ListItemNode` (no intermediate paragraph) |
| `TableSchema` (`@lexical/table`) | `TableRowNode` | If all cells, wrapped in a synthetic `TableRowNode`; else dropped |
| `TableRowSchema` (`@lexical/table`) | `TableCellNode` | Dropped |

A rule typically passes a schema when it knows its children's
allowed type — the legacy `wrapContinuousInlines` and
`ArtificialNode__DO_NOT_USE` cases are now `BlockSchema` and
`NestedBlockSchema` respectively:

```ts
const HeadingRule = defineImportRule({
  match: sel.tag('h1', 'h2', 'h3', 'h4', 'h5', 'h6'),
  $import: (ctx, el) => {
    const node = $createHeadingNode(el.nodeName.toLowerCase() as HeadingTagType);
    node.splice(0, 0, ctx.$importChildren(el, {schema: InlineSchema}));
    return [node];
  },
});
```

Custom schemas implement `ChildSchema` directly. `$accepts`,
`$packageRun`, and `$finalize` are invoked inside the editor context
of the surrounding walk, so they receive `LexicalNode` arguments and
can call `$is*` predicates / node methods without setting up their
own `editor.read`.

### When `$packageRun` runs and `onReject` doesn't

The schema walks the assembled child array once, partitioning into
accepted children (passed through individually) and maximal runs of
non-accepted children. For each rejected run, `$packageRun` runs
first; if it's missing or returns `[]`, `onReject` decides:

- `'drop'` (default) silently discards the run.
- `'hoist'` emits the run unchanged at the same position. This
  surfaces the mixed content to the calling rule's parent — only
  useful when the rule's caller is prepared to receive mixed
  children. It does NOT lift the run *out* of the calling rule's
  parent.

`$packageRun` is the right hook when the rejected content has a
sensible re-shape that still belongs *inside* the rule's parent —
e.g. `BlockSchema` wraps a run of inline siblings in a
`ParagraphNode`, `TableSchema` wraps cells in a synthesized row.

### Lifting blocks out of an inline parent

Schemas cannot change the parent the rule already created. The
canonical example is an inline element with block children:

```html
<a href="link"><h1>some text</h1><div>more text</div></a>
```

The desired output is to lift each block out of the link and
redistribute the link onto the block's inline contents:

```
HeadingNode
└─ LinkNode("link")
   └─ TextNode("some text")
ParagraphNode
└─ LinkNode("link")
   └─ TextNode("more text")
```

`InlineSchema` doesn't help here: with `onReject: 'drop'` the
headings are lost, with `'hoist'` they emerge unwrapped, and there's
no `$packageRun` shape that produces "a list of blocks each holding
the original inline wrapper" because the schema sees only the
children, not the parent.

This is a rule-level concern, but `@lexical/html` ships the
`$distributeInlineWrapper(children, $makeWrapper)` helper so rules
that produce an inline parent (e.g. `LinkNode`, `MarkNode`) can
opt in with one line:

```ts
import {
  $distributeInlineWrapper,
  defineImportRule,
  sel,
} from '@lexical/html';
import {$createLinkNode} from '@lexical/link';

const AnchorRule = defineImportRule({
  match: sel.tag('a'),
  $import: (ctx, el) => {
    const href = el.getAttribute('href') || '';
    return $distributeInlineWrapper(ctx.$importChildren(el), () =>
      $createLinkNode(href),
    );
  },
});
```

The helper walks the children: each block is descended into and its
inline content is wrapped with a fresh instance from `$makeWrapper`;
each contiguous inline run at the top level becomes its own wrapped
node. The enclosing `BlockSchema` then packages the inline-wrapped
runs into paragraphs as usual.

## Context

`ImportContext` is the per-rule environment exposed as `ctx` to
`$import`. It provides:

- `ctx.captures` — typed regex captures from this rule's selector.
- `ctx.get(cfg)` — read an `ImportStateConfig` value.
- `ctx.$importChildren(parent, opts)` — recurse into children.
- `ctx.$importOne(node, opts)` — recurse into one node.
- `ctx.session` — per-import mutable store (see [Sessions](#sessions)).

### State configs and `ctx.get`

`createImportState` mints a typed key, similar to `createState` for
node state but scoped to the import pipeline:

```ts
import {createImportState} from '@lexical/html';

const ImportMode = createImportState<'paste' | 'deserialize'>(
  'app/importMode',
  () => 'paste',
);
```

Rules read it with `ctx.get(ImportMode)`. The value is supplied
either as a `contextDefaults` entry on the extension config (sticks
for every import call) or as a per-call `context` override on
`$generateNodesFromDOM`:

```ts
import {contextValue} from '@lexical/html';

dep.output.$generateNodesFromDOM(dom, {
  context: [contextValue(ImportMode, 'deserialize')],
});
```

A nested `$importChildren` can also branch context for its descendants
via `opts.context`:

```ts
import {contextValue, ImportTextFormat} from '@lexical/html';
import {IS_BOLD} from 'lexical';

ctx.$importChildren(el, {
  context: [contextValue(ImportTextFormat, ctx.get(ImportTextFormat) | IS_BOLD)],
});
```

Branched values are restored on the way back out — siblings outside
the branched subtree see the unchanged inherited value.

### Built-in states

`@lexical/html` ships several states out of the box:

- **`ImportSource`** (`'paste' | 'unknown'`) — identifies how this
  import started. Defaults to `'unknown'`; the clipboard handler sets
  `'paste'`. Rules can branch on it to adapt behavior (e.g. preserve
  more whitespace on `'paste'`). Apps that need a richer vocabulary
  (e.g. `'drop'`, `'deserialize'`) can define their own
  `ImportStateConfig` and pass it through the same `context` slot.
- **`ImportSourceDataTransfer`** (`DataTransfer | null`) — the original
  `DataTransfer` the paste/drop came from, surfaced so rules can peek
  at companion MIME types or attached files. `null` outside clipboard
  imports. See [below](#importsourcedatatransfer).
- **`ImportTextFormat`** (`number`, a `TextFormatType` bitmask) —
  used by the inline-format rules (`<b>`, `<strong>`, `<em>`, …) to
  propagate format bits to descendant TextNodes. Replaces the legacy
  `forChild` chain that the inline tags previously used. Build your
  own format propagation by branching this state.
- **`ImportTextStyle`** (`Readonly<Record<string, string>>`) — parsed
  CSS-property record (e.g. `{color: 'red', 'font-family': 'serif'}`)
  inherited by descendant TextNodes and materialized onto their
  `style` string. Used by the core `#text` rule to pick up
  inheritable cell/span styles like `color`. Properties already
  covered by `ImportTextFormat` (`font-weight`, `font-style`,
  `text-decoration`, `vertical-align`) are filtered out so they
  remain owned by the format-bit path.
- **`ImportOverlays`** — session slot (`{dispatch: CompiledDispatch}[]`)
  holding overlays installed during the preprocess phase. The walker
  primes its overlay stack from this list before starting, so a
  preprocess can scope an overlay to the whole document based on a
  signal it detected (e.g. a Word `Generator` meta tag). See
  [Preprocessors](#preprocessors).
- **`ImportWhitespaceConfig`** — controls text-node whitespace
  handling (which DOM elements preserve whitespace, which count as
  inline siblings). See below.

### `ImportWhitespaceConfig`

The text-node whitespace handler walks DOM siblings to decide
whether trailing/leading spaces should be preserved (the neighbor is
inline text) or collapsed (the neighbor is a block boundary). Two
predicates govern this:

```ts
interface WhitespaceImportConfig {
  preservesWhitespace: (node: Node) => boolean;
  isInline: (node: Node) => boolean;
}
```

The defaults match the legacy behavior: an element preserves
whitespace if its `nodeName` is `'PRE'` or its inline `style.whiteSpace`
starts with `'pre'`; an element is inline if its inline `style.display`
starts with `'inline'` or its tag name is in the standard inline-tag
set used by lexical core's `isInlineDomNode` / `isBlockDomNode`
helpers (`a`, `abbr`, `acronym`, `b`, `cite`, `code`, `del`, `em`,
`i`, `ins`, `kbd`, `label`, `mark`, `output`, `q`, `ruby`, `s`,
`samp`, `span`, `strong`, `sub`, `sup`, `time`, `u`, `tt`, `var`).
The canonical list lives in `packages/lexical/src/LexicalUtils.ts` —
see the `INLINE_TAG_RE` / `BLOCK_TAG_RE` exports if you want to
inspect or extend the defaults.

To recognize custom tags (e.g. a custom `<tooltip>` that should be
treated as inline so the spaces around it survive), override the
predicate:

```ts
import {
  contextValue,
  defaultIsInline,
  defaultPreservesWhitespace,
  ImportWhitespaceConfig,
} from '@lexical/html';
import {isHTMLElement} from 'lexical';

configExtension(DOMImportExtension, {
  contextDefaults: [
    contextValue(ImportWhitespaceConfig, {
      isInline: (node) =>
        defaultIsInline(node) ||
        (isHTMLElement(node) && node.nodeName === 'TOOLTIP'),
      preservesWhitespace: defaultPreservesWhitespace,
    }),
  ],
})
```

This is the declarative replacement for setting `display: inline` on
the element from inside an extended TextNode importer.

## Sessions

`ImportSession` is the **root-layer context record** of the walk —
a mutable, document-order-shared store on `ctx`. Use it to make
information from a node visited earlier in the document available
to nodes visited later — e.g. a `<style>` / `<meta>` tag at the
top of the document influencing how later elements are interpreted.

The session and the scoped context share the same
`ImportStateConfig` keys you create with `createImportState`:

- `ctx.get(cfg)` reads through the current branch's prototype chain
  (a `$importChildren({context})` branch layered above the session
  record, falling through to the session record itself, falling
  through to the editor's `contextDefaults`, then to the config's
  default).
- `ctx.session.get(cfg)` reads the same chain starting at the
  session record (skips any active branch overlay).
- `ctx.session.set(cfg, v)` / `update` mutate the session record's
  own properties. Every unshadowed `ctx.get(cfg)` later in the walk
  (including in not-yet-entered branches) picks up the new value.
- A branch that writes `cfg` shadows the session value for the
  duration of the branch only; on return, scoped reads see the
  session value again.

```ts
import {createImportState} from '@lexical/html';

const Stylesheets = createImportState<string[]>(
  'app/stylesheets',
  () => [],
);

const CollectStyleSheetsRule = defineImportRule({
  match: sel.tag('style'),
  $import: (ctx, el) => {
    ctx.session.update(Stylesheets, (prev) => [
      ...prev,
      el.textContent ?? '',
    ]);
    return [];
  },
});

const ConsumesStyleSheetsRule = defineImportRule({
  match: sel.tag('article'),
  $import: (ctx, el) => {
    const sheets = ctx.session.get(Stylesheets);
    // ... use the collected stylesheet text however the app needs
  },
});
```

A fresh session record is created for every `$generateNodesFromDOM`
call. It chains to the ambient import context when the call runs
nested inside another import operation — a rule re-entering the walk
for sub-content, or raw HTML inside a `@lexical/mdast` Markdown import
— so states layered by the outer operation stay readable; the
outermost call chains to the editor's `contextDefaults`. Per-call
`options.context` pairs are seeded into it before any preprocessors
run, and preprocess-time `ctx.session.set` writes mutate the same
record (never the parent, so session writes don't leak outward).

## Preprocessors

Before walking begins, `DOMImportExtension` runs a stack of
preprocessors against the input DOM. They're middleware-shaped:

```ts
type DOMPreprocessFn = (
  dom: Document | ParentNode,
  ctx: DOMPreprocessContext,
  $next: () => void,
) => void;
```

Each step can:

- Mutate the DOM in place (e.g. inline stylesheet rules onto
  matching elements, strip unsafe nodes, normalize attributes,
  resolve relative URLs).
- Write to `ctx.session` — the session IS the root layer of the
  walk's context, so writes are visible to both `ctx.session.get`
  and to unshadowed `ctx.get(cfg)` reads in any branch.
- Call `$next()` to defer to the next-lower preprocessor (top of stack
  runs first); skip the call to short-circuit.

The default config registers
[`$inlineStylesFromStyleSheets`](#inlinestylesfromstylesheets) — the
same Excel-flavored CSS preprocess the legacy
`$generateNodesFromDOM` uses. Apps append more preprocessors via
`DOMImportConfig.preprocess` or per-call via
`GenerateNodesFromDOMOptions.preprocess`.

```ts
const $stripScripts: DOMPreprocessFn = (dom, _ctx, $next) => {
  const root = 'body' in dom ? dom.body : (dom as ParentNode);
  for (const el of Array.from(root.querySelectorAll('script'))) {
    el.remove();
  }
  $next();
};

configExtension(DOMImportExtension, {
  preprocess: [$stripScripts],
})
```

### Preprocess order

`preprocess` composes in the opposite array direction from
[`rules`](#dispatch-order) but produces the same precedence. `mergeConfig`
**appends** each contribution to the accumulated stack, and the runner
starts at the **last** entry and works backwards. So:

- Within one contribution, the **last** entry runs first and wraps the
  ones written before it.
- Because configs are merged in dependency order, an extension's
  preprocessors run before — and can wrap, via `$next()` — those of its
  dependencies. `$inlineStylesFromStyleSheets`, sitting in the extension's
  own base config, runs last of all, and only if every preprocessor above
  it calls `$next()`.
- Per-call preprocessors from `GenerateNodesFromDOMOptions.preprocess` are
  appended on top of the configured stack, so they run **before** the
  configured ones.

Skipping `$next()` is therefore a real decision: it drops every
lower-priority preprocessor, including the built-in stylesheet inlining.

### Reading meta tags into context

A common pattern: a preprocess step inspects a `<meta>` tag (or any
DOM marker), then layers a typed context value the rest of the walk
can branch on.

```ts
import {createImportState} from '@lexical/html';

const DocumentLanguage = createImportState<string>(
  'app/documentLanguage',
  () => 'unknown',
);

const $readMetaLang: DOMPreprocessFn = (dom, ctx, $next) => {
  const root = 'body' in dom ? dom.body : (dom as ParentNode);
  const meta = root.querySelector('meta[name="content-language"]');
  if (meta && meta.getAttribute('content')) {
    ctx.session.set(DocumentLanguage, meta.getAttribute('content')!);
  }
  $next();
};
```

### `$inlineStylesFromStyleSheets`

The default preprocessor resolves CSS rules from `<style>` tags onto
matching elements as inline styles, so the rest of the pipeline can
read those styles via plain `el.style.foo`. Apps like Excel paste
HTML in this shape; the preprocess collapses the indirection so rule
selectors and bodies don't need to chase stylesheets themselves.
Re-exported as a `DOMPreprocessFn` for apps that want to compose
their own preprocess pipeline:

```ts
import {$inlineStylesFromStyleSheets} from '@lexical/html';

configExtension(DOMImportExtension, {
  preprocess: [
    $appPreprocess,
    // The stack runs from the END of the array, so listing the inliner
    // last makes it run FIRST — useful when `$appPreprocess` expects the
    // styles to already be inlined. (The copy in the extension's base
    // config runs at the very bottom of the stack, after everything
    // else, so re-listing it here is how you pull it forward.)
    $inlineStylesFromStyleSheets,
  ],
});
```

See [Preprocess order](#preprocess-order) for the full composition rules.

## `$importChildren` rules overlay

`ctx.$importChildren(parent, {rules: defineOverlayRules([...])})`
installs an **overlay** dispatcher active only for the duration of
that children traversal (and nested `$importChildren` calls that
don't push their own overlay). Overlay rules are checked BEFORE the
main dispatcher; calling `$next()` from an overlay rule falls through
to the next overlay-or-main rule.

This lets you scope cost-bearing rules to the subtrees where they
apply, rather than paying the predicate cost on every paste. The
GitHub raw-file-view code-table rule in `@lexical/code-core` uses
the overlay to unwrap `<tr>` / `<td>` only while processing a code
table:

```ts
// Compile once at module scope. `defineOverlayRules` builds the same
// tag-bucketed dispatch table the main config uses, so each
// $importChildren call reuses it instead of recompiling.
const GitHubCodeTableOverlayRules = defineOverlayRules([
  defineImportRule({
    match: sel.tag('tr', 'td'),
    $import: (ctx, el) => ctx.$importChildren(el),
    name: '@lexical/code/github-code-table/unwrap',
  }),
]);

const GitHubCodeTableRule = defineImportRule({
  match: sel.tag('table').classAll('js-file-line-container'),
  $import: (ctx, el) => {
    const node = $createCodeNode();
    node.splice(
      0,
      0,
      ctx.$importChildren(el, {rules: GitHubCodeTableOverlayRules}),
    );
    return [node];
  },
});
```

Outside the code table, the `tr` / `td` rule from `@lexical/table` is
the only one consulted; the overlay isn't installed unless we enter
a code-table subtree.

`ImportChildrenOpts.rules` only accepts a `CompiledOverlayRules`
produced by `defineOverlayRules` — a raw rule array won't typecheck.
This is by design: a one-off overlay built inline on every walk would
recompile the dispatcher each time, defeating the point of the overlay
being a fast-path.

### Composing overlays

`defineOverlayRules` accepts both raw `DOMImportRule`s and other
`CompiledOverlayRules` in the same list (the union is
`DOMImportRuleEntry`). Existing overlays are inlined at their position
in priority order — earlier entries dispatch first — so any number of
overlays compose with a single call, recompiled once.

```ts
const allOverlays = defineOverlayRules([
  GitHubCodeTableOverlayRules,
  ExcelTableOverlayRules,
  // ...plus inline rules if you want them at this priority position:
  defineImportRule({match: sel.tag('foo'), $import: …}),
]);

ctx.$importChildren(el, {rules: allOverlays});
```

The same `DOMImportRuleEntry` union is accepted by
`DOMImportConfig.rules` (the extension-level rule list), so a library
that ships a `CompiledOverlayRules` can be dropped straight into
`configExtension(DOMImportExtension, {rules: […]})` without unpacking.

This is the definition-time complement to runtime composition (an
overlay rule's `$import` calling
`ctx.$importChildren(el, {rules: another})` to push a nested overlay
on top of the current stack): compose when you want a fixed merged
overlay across an entire subtree, nest when the inner overlay should
only apply for a deeper region.

### Walk-wide overlays installed by a preprocessor

A preprocessor can install an overlay for the entire walk by writing to
the built-in `ImportOverlays` session slot. The runtime reads it once
before walking and seeds the overlay stack from it, so rules don't have
to bracket each subtree with `$importChildren({rules: …})`.

This is how you handle paste-source-conditional rule sets: detect the
source in preprocess, install only the relevant overlay, and pay
nothing for other sources.

```ts
import {
  defineOverlayRules,
  type DOMPreprocessFn,
  ImportOverlays,
} from '@lexical/html';

const WordPasteOverlay = defineOverlayRules([
  WordOPRule,
  WordListParagraphRule,
  // …
]);

const $installWordOverlay: DOMPreprocessFn = (dom, ctx, $next) => {
  const meta = dom.querySelector('meta[name="Generator"]');
  if (meta && /Microsoft Word/i.test(meta.getAttribute('content') || '')) {
    ctx.session.update(ImportOverlays, (prev) => [...prev, WordPasteOverlay]);
  }
  $next();
};
```

That is the pattern, not something you have to write for Word lists
specifically: `@lexical/list` ships this exact preprocess as
`WordListImportExtension`. It is opt-in — `ListExtension` does not depend
on it, so an editor that never pastes from Word does not bundle it:

```ts
import {WordListImportExtension} from '@lexical/list';
import {defineExtension} from 'lexical';

defineExtension({
  dependencies: [WordListImportExtension],
  name: 'my-editor',
});
```

See `packages/lexical-list/src/__tests__/unit/ListImportExtension.test.ts`
("MS Word paste — preprocess-installed overlay") for a worked unit
test, and [`dev-examples/dom-import`](https://github.com/facebook/lexical/tree/main/dev-examples/dom-import)
for a running editor that exercises the same overlay end-to-end (a
reduced rich-text editor with lists, tables, code blocks, markdown
shortcuts, and an "Import HTML" dialog so you can paste raw HTML
without needing a real clipboard `text/html` slot). The dev-example
also ships a VS Code → Safari paste fixture and the matching
`@lexical/code-core` preprocess that turns the flat sibling run of
monospace+pre divs into a single `CodeNode`.

## ClipboardImportExtension

The clipboard's paste handler (`$insertDataTransferForRichText`)
delegates to `ClipboardImportExtension`. Its output owns the full
paste-side iteration: it walks a per-MIME-type priority list, reads
the corresponding `DataTransfer` slot, and invokes that MIME type's
handler stack.

`ClipboardImportConfig` mirrors `GetClipboardDataExtension`:

```ts
export interface ClipboardImportConfig {
  $importMimeType: ImportMimeTypeConfig;
  priority: ImportMimeTypePriority;
}
```

- `$importMimeType` — per-MIME-type stack of middleware functions
  `(data, selection, $next, dataTransfer) => boolean`. Top of stack runs
  first; `$next()` defers to the next-lower; return `true` to claim the
  data. The `dataTransfer` is the original `DataTransfer` the paste/drop
  came from, so a handler can peek at companion MIME types or attached
  files (see [`ImportSourceDataTransfer`](#importsourcedatatransfer) for
  how to surface it to rules).
- `priority` — a per-MIME-type weight map (`Record<string, number>`,
  lower runs first). Composable: each extension contributes weights
  for its own MIME types without coordinating with others.

```ts
configExtension(ClipboardImportExtension, {
  $importMimeType: {
    'application/vnd.myapp+json': [
      (data, selection, editor) => {
        const nodes = parseMyAppFormat(data);
        $insertGeneratedNodes(editor, nodes, selection);
        return true;
      },
    ],
  },
  // Slot between 'application/x-lexical-editor' (0) and 'text/html' (10).
  priority: {'application/vnd.myapp+json': 5},
})
```

### Routing pastes through `DOMImportExtension`

The easy on-switch is `ClipboardDOMImportExtension` from
`@lexical/clipboard` — add it to your dependencies and `text/html`
pastes and drops route through the new pipeline (forwarding
`ImportSource='paste'` and `ImportSourceDataTransfer` automatically).
The node extensions already registered their rules, so nothing else
needs to be configured:

```ts
import {defineExtension} from 'lexical';
import {ClipboardDOMImportExtension} from '@lexical/clipboard';
import {RichTextExtension} from '@lexical/rich-text';

defineExtension({
  name: 'app',
  dependencies: [
    RichTextExtension,
    // …other node extensions (list, link, table, code, …)…
    ClipboardDOMImportExtension,
  ],
});
```

If you need to customize the per-MIME stack (e.g. inspect the HTML
before walking, or pre-strip a known wrapper), stack your own handler
manually via `configExtension(ClipboardImportExtension, …)` instead:

```ts
import {$getEditor, configExtension, defineExtension} from 'lexical';
import {
  ClipboardImportExtension,
  $insertGeneratedNodes,
} from '@lexical/clipboard';
import {
  $generateNodesFromDOMViaExtension,
  contextValue,
  CoreImportExtension,
  DOMImportExtension,
  ImportSource,
  ImportSourceDataTransfer,
} from '@lexical/html';

defineExtension({
  name: 'app',
  dependencies: [
    CoreImportExtension,
    configExtension(ClipboardImportExtension, {
      $importMimeType: {
        'text/html': [
          (html, selection, _$next, dataTransfer) => {
            const parser = new DOMParser();
            const dom = parser.parseFromString(html, 'text/html');
            const nodes = $generateNodesFromDOMViaExtension(dom, {
              context: [
                contextValue(ImportSource, 'paste'),
                contextValue(ImportSourceDataTransfer, dataTransfer),
              ],
            });
            $insertGeneratedNodes($getEditor(), nodes, selection);
            return true;
          },
        ],
      },
    }),
  ],
});
```

Apps that don't configure `ClipboardImportExtension` keep the legacy
behavior — `$insertDataTransferForRichText` falls back to the same
defaults the legacy code path uses, including the legacy
`$generateNodesFromDOM` for HTML.

### `ImportSourceDataTransfer`

A builtin `ImportStateConfig<DataTransfer | null>` slot for surfacing
the original paste/drop `DataTransfer` to import rules and
preprocessors. The clipboard handler shown above forwards it via
`context`; rules can then read it during the walk:

```ts
import {ImportSourceDataTransfer} from '@lexical/html';

const ExcelAwareTableRule = defineImportRule({
  match: sel.tag('table'),
  $import: (ctx, el, $next) => {
    const transfer = ctx.get(ImportSourceDataTransfer);
    // Excel ships an HTML alternative alongside a real RTF payload; if
    // we see both, we may want to defer to the RTF handler instead of
    // parsing Excel's HTML quirks.
    if (transfer && transfer.types.includes('application/rtf')) {
      return $next();
    }
    // …handle the table…
  },
});
```

Defaults to `null` outside of clipboard imports (e.g. headless
`$generateNodesFromDOM` calls). Use sparingly — the safer pattern is
to decide *which* MIME-type payload to walk in the clipboard handler
stack and hand a finalized DOM to the rules; only fall back to peeking
at `ImportSourceDataTransfer` when the source-detection signal
genuinely lives in a companion slot.

## Migrating from `importDOM`

The legacy `static importDOM(): DOMConversionMap` declaration on each
node class still works; the new pipeline is opt-in. When you're
ready to move a custom node, the translation is mechanical:

| Legacy concept | New equivalent |
| --- | --- |
| `static importDOM(): DOMConversionMap` returning `{tag: () => ({conversion, priority})}` | One or more `defineImportRule({match, $import})` entries |
| Numeric `priority` (0–4) | Position in the compiled `rules` list (earlier entry runs first; an extension's rules come ahead of its dependencies') plus `$next()` for deferring — see [Dispatch order](#dispatch-order) |
| `forChild(node, parent)` | `ctx.$importChildren(el, {context: [...], $onChild})` |
| `after(children)` | `ctx.$importChildren(el, {$after})` |
| `wrapContinuousInlines` (block ancestor case) | `ctx.$importChildren(el, {schema: BlockSchema})` |
| `ArtificialNode__DO_NOT_USE` (nested block) | `ctx.$importChildren(el, {schema: NestedBlockSchema})` |
| Cross-tag setup via shared state | `createImportState` + `ctx.get` (scoped) or `ctx.session.get/set` (flat) |
| Mutating the DOM before walking | `DOMPreprocessFn` in `DOMImportConfig.preprocess` |
| `html: {import: ...}` field on a node-providing extension | `configExtension(DOMImportExtension, {rules: […]})` |

A migrated rule typically replaces a forChild chain with explicit
context propagation (clearer + survives across rule boundaries), and
an `after` callback with either `$after` (when the post-processing
runs on this rule's children) or a schema's `$packageRun` / `$finalize`
(when the same logic belongs to anything appending to this kind of
parent).

### Importing children is explicit

The most consequential difference: the legacy `DOMConversion` pipeline
walked an element's children for you (via `wrapContinuousInlines` /
the post-conversion runner). In `DOMImportExtension`, a rule that
wants its element's children must call `ctx.$importChildren(el)`
itself.

This is deliberate. A rule decides:

- Whether to recurse at all (skip children to drop them, or look at
  `el` only)
- Which schema the children must satisfy
  (`schema: BlockSchema | InlineSchema | NestedBlockSchema | …`)
- Whether to install a subtree-scoped overlay
  (`rules: defineOverlayRules([...])`)
- Where the produced children attach — usually
  `parent.splice(0, 0, ctx.$importChildren(el))`, but a rule that
  wants flat output can just return the array.

### Concrete example: blockquote

A typical legacy `importDOM` for a quote-like node:

```ts
// Legacy
class QuoteNode extends ElementNode {
  static importDOM(): DOMConversionMap | null {
    return {
      blockquote: () => ({
        conversion: (_el) => ({node: $createQuoteNode()}),
        priority: 0,
      }),
    };
  }
}
```

The migrated rule:

```ts
import {
  $createQuoteNode,
  BlockSchema,
  defineImportRule,
  InlineSchema,
  sel,
} from '@lexical/html';

const QuoteRule = defineImportRule({
  $import: (ctx, el) => {
    const node = $createQuoteNode();
    // The recursion is explicit. QuoteNode contains inline children
    // only, so we constrain the schema; rejected blocks hoist out.
    node.splice(0, 0, ctx.$importChildren(el, {schema: InlineSchema}));
    return [node];
  },
  match: sel.tag('blockquote'),
  name: '@app/quote',
});

configExtension(DOMImportExtension, {rules: [QuoteRule]});
```

The legacy pipeline would have inferred the recursion + wrapping
behavior from `QuoteNode`'s position in the tree and its acceptance
rules. In the new pipeline both are stated at the call site: the rule
asks for inline children, gets them packaged by `InlineSchema`, and
attaches them via the normal `ElementNode.splice` primitive.

### Concrete example: playground

The lexical-playground application was migrated in
[#8590](https://github.com/facebook/lexical/pull/8590), which should
be a good example of what it would take to move an entire application
from `importDOM` to `DOMImportExtension` (while adding test coverage).

## Capabilities

Current:

- Typed selectors with element-narrowing through to `$import`'s
  signature; no instanceof or cast boilerplate.
- Middleware `$next()` chain replaces numeric priority.
- Per-rule capture map (`ctx.captures`) avoids re-running regex
  inside the rule body.
- `ChildSchema` enforces structural invariants (block/inline/list/
  table/code) without per-importer wrapping logic.
- Per-call context (`ImportSource`), persistent context state
  (`ImportTextFormat`, `ImportWhitespaceConfig`, app-defined).
- Mutable session store for document-order-shared info.
- DOM preprocess middleware (default: stylesheet inlining).
- Subtree-scoped `rules` overlay for cost-bearing predicates.
- Clipboard pipeline owns the whole `DataTransfer` iteration via
  `ClipboardImportExtension`; per-MIME-type priority weights compose
  across extensions.

Future:

- The default pipeline (`$generateNodesFromDOM` and the static
  `importDOM` methods on lexical-core node classes) still works
  side-by-side. There is no plan in this iteration to flip the
  default — both will coexist while ecosystem migrates.
