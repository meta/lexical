# `@lexical/mdast`

[![See API Documentation](https://lexical.dev/img/see-api-documentation.svg)](https://lexical.dev/docs/api/modules/lexical_mdast)

> ⚠️ **Experimental:** everything in this package is marked
> `@experimental` and may change between any two Lexical releases —
> including breaking renames, signature changes, or behavior changes —
> until the API stabilizes. `@lexical/markdown` remains the supported
> default for production apps that don't want to track an experimental
> API.

An alternative to `@lexical/markdown` that is built on the
[micromark](https://github.com/micromark/micromark) /
[mdast](https://github.com/syntax-tree/mdast) ecosystem.

Where `@lexical/markdown` ships its own regular-expression based parser, this
package delegates Markdown parsing and serialization to `micromark` and
`mdast-util-*`. That means **CommonMark + GFM compliance** comes from the same
parser used by `remark`, and Markdown **shortcuts** are recognized by feeding
keystrokes back through that same parser — there is no second grammar to keep
in sync.

Like `@lexical/markdown`, the original syntax of a construct is preserved on
the Lexical nodes (the bullet character of a list, a code block's fence, and a
hard line break's style), so re-serializing stays **close to the source**,
though not exact — `* a`/`+ b` bullets and `~~~` fences round-trip unchanged,
while tables are re-padded and some constructs are normalized (see the guide).

## Configured through extensions

`@lexical/mdast` is set up **exclusively** through the Lexical extension
system, modeled on `@lexical/html`'s `DOMImportExtension`. Each feature
extension ships the nodes it needs and contributes its import/export rules (and
the micromark/mdast extensions that tokenize them) to the core
`MdastExtension` registry:

CommonMark features:

| Extension | Ships | Adds |
| --- | --- | --- |
| `MdastHeadingExtension` | `HeadingNode` | ATX & setext headings |
| `MdastBlockquoteExtension` | `QuoteNode` | block quotes |
| `MdastListExtension` | `ListNode`, `ListItemNode` | ordered/unordered lists |
| `MdastCodeExtension` | `CodeNode` | fenced & indented code |
| `MdastLinkExtension` | `LinkNode` | links, `<autolinks>`, reference links |
| `MdastHorizontalRuleExtension` | `HorizontalRuleNode` | thematic breaks (`---`) |

GFM features:

| Extension | Ships | Adds |
| --- | --- | --- |
| `MdastStrikethroughExtension` | – | `~~strikethrough~~` |
| `MdastTaskListExtension` | – | task lists (`- [x] …`) |
| `MdastAutolinkLiteralExtension` | – | literal autolinks (bare `https://…` in prose) |
| `MdastTableExtension` | `TableNode`, … | tables |

Behavior and convenience bundles:

| Extension | Adds |
| --- | --- |
| `MdastCommonMarkExtension` | bundle of the six CommonMark extensions |
| `MdastGfmExtension` | bundle of the four GFM extensions |
| `MdastRichTextExtension` | bundle of heading + blockquote |
| `MdastExtension` | core registry, Markdown import and export |
| `MdastShadowRootQuoteExtension` | opt-in: blockquotes as block containers (full-fidelity nested content) |
| `MdastHtmlExtension` | opt-in: raw HTML routed through the `@lexical/html` DOM import rules; HTML-encoded export via `$exportViaDOM` / `rawHtmlBlock` |
| `MdastShortcutsExtension` | streaming keyboard shortcuts |

Everything composes granularly and degrades gracefully: an editor with only
the extensions it wants imports unsupported constructs as their content
(without `MdastTableExtension`, which brings the GFM table grammar, a table
is read as plain CommonMark), and the typing shortcuts — driven by the same
registry — only fire for constructs the editor can represent (`> ` stays
literal without `MdastBlockquoteExtension`).

`MdastExtension` owns the shared configuration and exposes both import and
export. Feature extensions depend on it automatically.

## Usage

```ts
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  MdastCommonMarkExtension,
  MdastExtension,
  MdastGfmExtension,
  MdastShortcutsExtension,
} from '@lexical/mdast';
import {buildEditorFromExtensions} from '@lexical/extension';
import {defineExtension} from 'lexical';

const editor = buildEditorFromExtensions(
  defineExtension({
    // CommonMark + GFM grammar, import + export (MdastExtension), and
    // typing shortcuts. Swap bundles for individual feature extensions
    // to trim what you don't need.
    dependencies: [
      MdastCommonMarkExtension,
      MdastGfmExtension,
      MdastExtension,
      MdastShortcutsExtension,
    ],
    name: '[root]',
  }),
);

// Import / export run inside the editor; both are `$`-functions.
editor.update(() => {
  $convertFromMarkdownString('# Hello *world*');
});
const markdown = editor.read(() => $convertToMarkdownString());
```

The same API is available from the editor as
`$getExtensionOutput(MdastExtension).$convertFromMarkdownString(...)`
and
`$getExtensionOutput(MdastExtension).$convertToMarkdownString(...)`.

`$convertSelectionToMarkdownString(selection?)` serializes only the
selected content (defaulting to the current selection): unselected
blocks and list items are skipped and partially selected text is
sliced to the selected range. A GFM table writes the rows and columns a
selection reaches, or a text or node selection within one cell as that
cell's blocks, as copying in a cell does.

### unified / remark interop

The mdast tree itself is part of the API, so editor content can flow
through the wider [unified](https://unifiedjs.com/) ecosystem — remark
plugins, `remark-rehype` for HTML rendering, tree diffing:

```ts
import {$convertFromMdast, $convertToMdast} from '@lexical/mdast';

// Editor -> mdast tree (before serialization).
const tree = editor.read(() => $convertToMdast());
// ... run remark plugins / transform the tree ...
// mdast tree -> editor.
editor.update(() => $convertFromMdast(tree));
```

The `*FromMarkdownString` functions parse the source text themselves
(which is also what enables source-based syntax preservation, e.g.
keeping `*` vs `-` bullets); the `*FromMdast` functions take an
already-parsed tree, where no source text exists so syntax
preservation is skipped.

To convert Markdown into nodes *without* replacing the document —
e.g. to insert at the current selection —
`$generateNodesFromMarkdownString(markdown)` (and its tree-taking
sibling `$generateNodesFromMdast(tree)`) returns a detached array of
block-level nodes and leaves the document and selection untouched:

```ts
import {$generateNodesFromMarkdownString} from '@lexical/mdast';

editor.update(() => {
  const selection = $getSelection();
  if ($isRangeSelection(selection)) {
    selection.insertNodes($generateNodesFromMarkdownString('# Inserted'));
  }
});
```

### Serialization options

Document-level `mdast-util-to-markdown` options (bullet, emphasis
marker, fence, ...) can be contributed like any other configuration —
scalar options in a `toMarkdownExtensions` entry apply document-wide
and override the package defaults:

```ts
import {MdastExtension} from '@lexical/mdast';
import {configExtension} from 'lexical';

// Serialize bullets as `+` and emphasis as `_`. Per-node syntax
// recorded on import (a list's bullet, a code block's fence, ...)
// still wins for those nodes' own output.
configExtension(MdastExtension, {
  toMarkdownExtensions: [{bullet: '+', emphasis: '_'}],
});
```

### Raw HTML (`MdastHtmlExtension`)

Markdown passes raw HTML through — GitHub-style `<details>` blocks, inline
`<kbd>` runs — and by default it imports as literal text. The opt-in
`MdastHtmlExtension` routes it through the editor's `@lexical/html`
`DOMImportExtension` rules instead, so **any HTML the editor can already
import works from Markdown**, and Markdown *inside* the construct keeps
working in both directions: the blocks after a blank line, as on GitHub,
and also text between the tags, such as the summary line below, which GFM
itself leaves raw:

```md
<details><summary>
The *summary* line
</summary>

The **body** blocks
</details>
```

- **Import**: raw HTML block sequences and inline tag runs are reassembled
  by tag balance (CommonMark splits blocks on blank lines), parsed with
  `DOMParser`, and dispatched through the DOM import rule registry.
  Markdown between the tags is parsed with the document's own grammar and
  substituted back in with the surrounding formatting context. Unclosed
  tags — including the `<p` / `<details` prefixes typing passes through —
  stay literal text.
- **Export**: register `$exportViaDOM` for a node type and its `exportDOM`
  becomes the single source of truth for the Markdown encoding too: the
  shell is rendered, the children channel and named slots (marked with
  `data-lexical-slot`, which is stripped from the output) are substituted
  with embedded Markdown, boolean attributes are normalized, and custom
  element tags get their own lines where CommonMark requires it to
  re-parse. For hand-written encodings, `rawHtmlBlock(...parts)` builds
  the same kind of node from a template of raw tag strings, embedded
  Markdown phrasing, and `{flow}` block runs.
- **Context states**: the Markdown pipeline runs under the same
  context-record mechanism as the `@lexical/html` import/render pipelines.
  The whole import walk runs with `ImportContextMarkdown` set (so a DOM
  rule can distinguish Markdown import from HTML paste); mdast import
  handlers read ambient state with `$getImportContextValue` and layer
  state for their subtree with `$withImportContext` around
  `ctx.importChildren` — visible to nested handlers and to DOM-rule
  sessions opened for raw HTML in that subtree, and to nothing outside
  it. On export, `RenderContextMarkdownExport` lets `exportDOM` diverge
  per destination (Markdown vs the HTML clipboard), and selection exports
  (`$convertSelectionToMarkdownString`) run under
  `RenderContextMarkdownSelection` carrying the selection, so a
  contributed to-markdown handler that appends end-of-document data can
  scope its output to a clipboard copy. An export rule reads the selection
  its own export is limited to as `context.selection` (`null` for a
  whole-document export, including one a handler runs during a selection
  export), which needs no active editor.

A complete HTML-encoded construct is one DOM import rule (which then also
serves HTML paste) plus one export rule:

```ts
import {$exportViaDOM, MdastHtmlExtension, MdastExtension} from '@lexical/mdast';
import {defineImportRule, DOMImportExtension, sel} from '@lexical/html';
import {configExtension, defineExtension} from 'lexical';

export const MdastCollapsibleExtension = defineExtension({
  name: 'collapsible-markdown',
  nodes: [CollapsibleNode],
  dependencies: [
    MdastHtmlExtension,
    configExtension(DOMImportExtension, {
      // sel.tag('details') -> CollapsibleNode; serves Markdown and paste.
      rules: [DetailsImportRule],
    }),
    configExtension(MdastExtension, {
      // exportDOM is the single source of truth for the encoding.
      exportRules: [{$export: $exportViaDOM, type: CollapsibleNode}],
    }),
  ],
});
```

The [mdast-editor dev example](https://github.com/meta/lexical/tree/main/dev-examples/mdast-editor)
demonstrates the block path (a `<details><summary>` collapsible with a
named summary slot), the inline path (`<kbd>` keys), and inline HTML text
formats (`<u>`, `<mark>`, `<sub>`/`<sup>`, `style="color: …"` spans).

### Custom mappings

Because extensions are the unit of configuration, you add or override behavior
by contributing rules to `MdastExtension` from your own extension:

```ts
import {MdastExtension} from '@lexical/mdast';
import {configExtension, defineExtension} from 'lexical';

export const MyMdastExtension = defineExtension({
  name: 'my-mdast',
  nodes: [MyNode],
  dependencies: [
    configExtension(MdastExtension, {
      importRules: [{type: 'myMdastType', $import: $importMyNode}],
      exportRules: [{type: MyNode, $export: $exportMyNode}],
      micromarkExtensions: [myMicromarkExtension()],
      mdastExtensions: [myMdastExtension()],
      toMarkdownExtensions: [myToMarkdownExtension()],
    }),
  ],
});
```

Export rule `type` accepts a Lexical type string or node class: `'text'` and
`TextNode` are equivalent. Rules also apply to subclasses, so a text rule
handles `TabNode` and custom text nodes unless a more specific rule exists.
The nearest matching ancestor runs first, regardless of contribution order. For
multiple rules targeting the same type (including a mix of strings and classes),
array order determines priority; contributions merged later are prepended.
Ancestor classes do not need to be registered in the editor themselves. Classes
must have their own node type; abstract classes without one (such as `ElementNode`)
are rejected.
Rules are resolved once when the editor is built.

Handlers can delegate with `context.next()`, which converts the same node
using the next handler and returns an array of output nodes. An export chain
runs lower-priority rules for the same type before moving to its ancestors,
from nearest to farthest. When no handlers remain, it uses the generic export
fallback. A handler can return the delegated result or modify it. Formatting
such as bold and italic wraps text in child nodes, so this uppercase example
walks the returned tree, including inline code:

```ts
import {MdastExtension, type MdastNode} from '@lexical/mdast';
import {configExtension, TextNode} from 'lexical';

function uppercaseText(nodes: readonly MdastNode[]): void {
  for (const node of nodes) {
    if (node.type === 'text' || node.type === 'inlineCode') {
      node.value = node.value.toUpperCase();
    } else if ('children' in node) {
      uppercaseText(node.children);
    }
  }
}

configExtension(MdastExtension, {
  exportRules: [{
    type: TextNode,
    $export: (_node, context) => {
      const output = context.next();
      uppercaseText(output);
      return output;
    },
  }],
});
```

Plain formatted text returned by text middleware is merged into adjacent text
runs so shared and overlapping formats serialize correctly. Output containing
extra fields such as `data`, or custom structure, is preserved as-is instead
of merged. Such middleware must ensure its output serializes correctly on its
own; adjacent bold nodes, for example, can produce `**a****b**`.

Import rules use mdast type strings: mdast nodes are plain objects,
without a Lexical node class hierarchy. Their `context.next()` runs the next
handler for the same type in contribution order, eventually reaching the
generic import fallback.

| Handler result | Import | Export |
| --- | --- | --- |
| `context.next()` | Runs the next handler for the same mdast type, or the generic import fallback when none remain. | Runs the next same-type or ancestor handler, or the generic export fallback when none remain. |
| `null` | Omits the node and its children. | Uses the default export directly, without trying remaining handlers. |
| `[]` | Omits the node and its children. | Omits the node. |
