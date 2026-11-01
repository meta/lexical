# Markdown with @lexical/mdast

:::warning Experimental

`@lexical/mdast` and everything described on this page are marked
`@experimental` and may change between any two Lexical releases —
including breaking renames, signature changes, or behavior changes —
until the API stabilizes. We track issues and proposals in the
[GitHub repo](https://github.com/meta/lexical); breaking changes
will be called out in release notes.

The existing `@lexical/markdown` package is unchanged and remains the
supported default for production apps that don't want to track an
experimental API.

:::

[`@lexical/mdast`](/docs/api/modules/lexical_mdast) is an alternative
to `@lexical/markdown` built on the
[micromark](https://github.com/micromark/micromark) /
[mdast](https://github.com/syntax-tree/mdast) ecosystem. Where
`@lexical/markdown` ships its own regular-expression based parser,
`@lexical/mdast` delegates parsing and serialization to the same
spec-compliant parser used by `remark`, and recognizes Markdown typing
shortcuts by feeding keystrokes back through that same grammar — there
is no second set of regular expressions to keep in sync with import.

The trade-off is bundle weight: the micromark/mdast stack costs
roughly 26 kB (min+gzip) more than the bespoke `@lexical/markdown`
implementation in an equivalent configuration, in exchange for
CommonMark + GFM compliance, one grammar shared by import and typing
shortcuts, and the micromark/mdast extension ecosystem (footnotes,
frontmatter, directives, ...) as the path for new syntax.

## Extensions are the unit of configuration

Modeled on `@lexical/html`'s `DOMImportExtension`, the package is
configured **exclusively** through the
[extension system](/docs/extensions/intro). Each feature extension
ships the nodes it needs and contributes its import/export rules (and
the micromark grammar that tokenizes them) to the core
`MdastExtension` registry. There is no transformer list to
curate and no `registerMarkdownShortcuts` call:

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
    dependencies: [
      // CommonMark: headings, quotes, lists, code, links, thematic breaks
      MdastCommonMarkExtension,
      // GFM: strikethrough, task lists, literal autolinks, tables
      MdastGfmExtension,
      // Import + export (MdastExtension bundles both directions)
      MdastExtension,
      // Streaming typing shortcuts, driven by the registry's grammar
      MdastShortcutsExtension,
    ],
    name: '[root]',
  }),
);

editor.update(() => $convertFromMarkdownString('# Hello *world*'));
const markdown = editor.read(() => $convertToMarkdownString());
```

Try it live in the
[mdast-editor dev example](pathname:///dev-examples/mdast-editor/), a WYSIWYG
Markdown editor with an editable Markdown source pane — typing on
either side exercises import or export through this package.

The bundles unpack into granular, one-construct-each extensions
(`MdastHeadingExtension`, `MdastBlockquoteExtension`,
`MdastTaskListExtension`, ...) for editors that only want some of the
grammar — see the
[full list](/docs/extensions/included-extensions) or the
[package README](/docs/packages/lexical-mdast). Granular
configurations degrade gracefully: unsupported constructs import as
their content (without `MdastTableExtension`, which brings the GFM
table grammar, a table is read as plain CommonMark), and typing
shortcuts only fire for constructs the editor can represent (`> `
stays literal without `MdastBlockquoteExtension`).

## Import and export share one extension

`MdastExtension` owns the compiled registry and exposes both import and export.
Feature extensions contribute their rules and grammar to it automatically.

Export rules accept a node type string or class (`'text'` or `TextNode`) and
apply to subclasses. The nearest matching ancestor takes precedence, so a
`TabNode` rule overrides a `TextNode` rule. Rules for the same type retain
contribution order: later extension contributions take priority. Classes must
have their own node type; abstract classes without one are rejected.

Import and export handlers can call `context.next()` to delegate conversion
of the same node and receive an array of output nodes to return or modify.
Export tries the remaining rules for the same type before its ancestors,
from nearest to farthest; import uses contribution order for the mdast type.
After the last handler, `next()` uses the generic fallback. Returning `null`
uses the default export directly, or omits the node and its children on import.
Returning `[]` omits the node in either direction.

## Round-trips are close, not exact

The literal syntax of each construct is preserved on the Lexical nodes
with [NodeState](/docs/concepts/node-state): list bullet `-`/`*`/`+`,
ordered delimiter `.`/`)`, code fence style and info-string meta,
setext vs ATX headings, hard-break style, soft line breaks, thematic
break marker, `*` vs `_` emphasis and strong markers (one of each for
the whole document, `_` if any was used, though not in named slots or
in text between the tags of an HTML block, unless `toMarkdownExtensions`
sets them), and link style (`[text](url)` vs `<autolink>` vs bare GFM
literal). Some forms are normalized, such as a run of text both bold
and italic on its own, written as emphasis around strong (`**_both_**`
comes back as `_**both**_`), and GFM tables, padded so their columns
line up and written as below. Nodes created in the editor defer to the
document-level serialization options, which can be configured by
contributing `mdast-util-to-markdown` options through
`toMarkdownExtensions`.

GFM tables (`MdastTableExtension`) import a column's alignment as the
element format of the paragraph in each of its cells, and write it from
the content of the column's header cell (the format of the block holding
the cell's first inline content, or of the nearest block around it with
one, or, when the cell has no inline content, of its first element
block, or else of the cell, where blocks in a nested table count for
nothing and start and end are none); a format GFM can't express leaves
the column unaligned. Export is lossy where GFM has no form for a
table's content: the content of a cell is exported by its export rules,
and the blocks that come out (and their line breaks) become lines
separated by `<br>` (whatever spelling of the tag, such as `<br/>` or
`</br>`, was read), with a code block's lines as inline code. A merged
cell is written where it starts with empty cells where it spans, flow
content with no form in a cell (such as a horizontal rule) is written
after the table, and the alignment of a body cell is dropped.
Editing tables in the editor also takes `TableExtension` from
`@lexical/table`.

## unified / remark interop

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

To parse Markdown into nodes without replacing the document (e.g. to
insert at the current selection), `$generateNodesFromMarkdownString`
returns a detached array of block-level nodes and leaves the document
and selection untouched.

## Raw HTML

Markdown passes raw HTML through — GitHub-style `<details>` blocks,
inline `<kbd>` runs — and by default it imports as literal text. The
opt-in `MdastHtmlExtension` routes it through the editor's
[`DOMImportExtension`](/docs/serialization/dom-import) rules instead,
so any HTML the editor can already import works from Markdown, and
Markdown *inside* the construct keeps working in both directions: the
blocks after a blank line, as on GitHub, and also text between the tags,
such as the summary line below, which GFM itself leaves raw:

```md
<details><summary>
The *summary* line
</summary>

The **body** blocks
</details>
```

On export the same idea runs in reverse: registering the generic
`$exportViaDOM` handler for a node type makes that node's own
`exportDOM` the single source of truth for its Markdown encoding —
the rendered shell has its children channel and named slots
substituted with embedded Markdown, and custom-element tags are
placed on their own lines where CommonMark requires it to re-parse.
`rawHtmlBlock(...parts)` builds the same kind of output from a
hand-written template. Context states parallel the HTML pipeline's:
`RenderContextMarkdownExport` lets `exportDOM` diverge between the
Markdown encoding and the HTML clipboard, and `ImportContextMarkdown`
lets a DOM rule distinguish Markdown import from HTML paste.

A complete HTML-encoded construct is one DOM import rule (which then
also serves HTML paste) plus one `$exportViaDOM` export rule — see
the [package README](/docs/packages/lexical-mdast) for a template and
the [mdast-editor dev example](pathname:///dev-examples/mdast-editor/) for
complete constructs on the block path (`<details><summary>` with a
named slot) and the inline path (`<kbd>`).

## Custom syntax

New syntax is added the same way the built-in features are built: an
extension contributes import/export rules and the micromark/mdast
grammar for its construct, and ships the nodes those rules need. See
the [package README](/docs/packages/lexical-mdast) for a template.

## Context states

The Markdown pipeline runs under the same context-record mechanism as
the `@lexical/html` import/render pipelines, so rules use the same
techniques in either registry:

- The whole import walk runs with `ImportContextMarkdown` set. An
  mdast import handler reads ambient state with
  `$getImportContextValue(...)` and layers state for its subtree with
  `$withImportContext(pairs)(() => ctx.importChildren(node))` — the
  layer is visible to nested handlers and to any DOM-rule session the
  subtree opens for raw HTML (DOM import sessions chain to the ambient
  import context), and to nothing outside it. `createImportState`
  defines app states exactly as it does for DOM rules.
- On export, `RenderContextMarkdownExport` marks `exportDOM` shells
  rendered for Markdown (`$exportViaDOM`), and selection exports
  (`$convertSelectionToMarkdownString`) run under
  `RenderContextMarkdownSelection` carrying the selection — a
  contributed to-markdown handler that appends end-of-document data
  (like the dev example's footnote definitions) reads it with
  `$getRenderContextValue` to scope its output to a clipboard copy. An
  export rule can also read the selection its own export is limited to as
  `context.selection` (`null` for a whole-document export, including one a
  handler runs during a selection export), which needs no active editor.

## Comparison with @lexical/markdown

| | `@lexical/markdown` | `@lexical/mdast` |
| --- | --- | --- |
| Parser | bespoke regular expressions | micromark (CommonMark + GFM spec-compliant) |
| Configuration | transformer arrays | extensions (nodes ship with their rules) |
| Typing shortcuts | separate matchers | same grammar as document import |
| Syntax preservation | partial | extensive, via NodeState |
| mdast tree access | – | `$convertToMdast` / `$convertFromMdast` |
| New syntax | custom transformer | micromark/mdast extension ecosystem |
| Bundle cost | baseline | ~+26 kB min+gzip |
| Stability | stable | **experimental** |
