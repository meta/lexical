# Compared with ProseMirror

Lexical and [ProseMirror](https://prosemirror.net) are both frameworks for
building rich text editors on top of `contentEditable`, and both keep an
immutable document model as the source of truth. This page collects the main
differences in one place, for readers who know one and are learning the other.

## Document model {#document-model}

Lexical's tree is shaped like the HTML it renders (see
[Document Model](./document-model.md)). This is a deliberate difference from
ProseMirror. ProseMirror's document is also a tree,
and blocks can contain other blocks, but the inline content of a textblock is
a flat sequence of nodes (text and inline nodes) with marks for formatting and
links, and every position in the document is a single integer.

| | Lexical | ProseMirror |
| -- | -- | -- |
| Document | Immutable tree of nodes, one `RootNode` | Immutable tree of nodes, one `doc` node |
| Node identity and navigation | Each node has a runtime key and knows its parent and siblings | Nodes are plain values with no parent links; a resolved position supplies ancestor context |
| Blocks | `ElementNode` subclasses (paragraph, heading, list, table, …), or a block `DecoratorNode` (image, embed, …) | Block nodes defined in the schema |
| Inline formatting | Format flags on each `TextNode` (bold, italic, code, …) | Marks on text |
| Links and other inline wrappers | Inline `ElementNode`s (`LinkNode`, `MarkNode`) that contain text nodes | Marks on text, like formatting |
| Embedded content | `DecoratorNode`, inline or block, rendered by your framework (for example React) | Leaf or atom nodes, often with a custom `NodeView` |
| Several editable regions in one node | [Named slots](./named-slots.md): regions addressed by name, like a card's `title`, each isolated so editing and selection never cross the boundary | Child nodes in the order the schema's content expression allows, optionally marked `isolating`, or a separate editor inside a `NodeView` |
| Addressing a position | Node key plus offset (`{key, offset, type}`) | One integer counted across the whole document |
| Allowed structure | Declared by node classes, enforced with node transforms and normalization | Declared by a schema of content expressions |
| Applying edits | Call node and selection methods inside `editor.update()` | Build a transaction from steps that address positions or ranges |
| Rendering | Each node's `createDOM()`/`updateDOM()`, applied by the reconciler, and optionally changed per node class by a `DOMRenderExtension` override | `toDOM` in the schema, or a `NodeView` |

## Serialization {#serialization}

Because a Lexical link is an element that already contains its text, it
exports as an `<a>` around those text nodes. A mark-based model has to find the
adjacent text that shares a mark and group it into one element first.

| Format | Lexical | ProseMirror |
| -- | -- | -- |
| JSON | `editorState.toJSON()`, restored with `editor.parseEditorState()` | `doc.toJSON()` and `Node.fromJSON(schema, json)` |
| HTML export | `$generateHtmlFromNodes()`, using each node's `createDOM()` or `exportDOM()` | `DOMSerializer.fromSchema(schema)`, using `toDOM` from the schema's nodes and marks |
| HTML import | `$generateNodesFromDOM()`, using `importDOM()` or `DOMImportExtension` rules | `DOMParser.fromSchema(schema)`, using the schema's `parseDOM` rules |
| Markdown | `@lexical/markdown` transformers or `@lexical/mdast` | `prosemirror-markdown`: a markdown-it parser and a serializer with a function per node and mark |
| Clipboard | Copy writes plain text, HTML, and Lexical JSON. Paste prefers the JSON, then HTML, then plain text. | Copy writes HTML and plain text. Paste parses the HTML with the schema's parse rules. |

In the JSON, a Lexical link is a `link` node with its text nodes as
`children`, and bold is a `format` value on a `text` node, where
ProseMirror's JSON gives each text node a list of `marks`. In both editors the
default HTML export reuses the definition that renders the editor
(`createDOM()` in Lexical, `toDOM` in ProseMirror), so the two stay in step
unless you override one. See [Serialization](../serialization/serialization.md)
for the details of each Lexical format.

## History {#history}

Both editors group consecutive edits into one undo step. Lexical's
[`HistoryExtension`](./history.md) merges edits made within `delay`
(300ms by default) and keeps an unlimited stack unless you set `maxDepth`.
ProseMirror's history plugin uses `newGroupDelay: 500` and `depth: 100` by
default, so `configExtension(HistoryExtension, {delay: 500, maxDepth: 100})`
matches its behavior.
