# `@lexical/rich-text`

This package provides a starting point for Lexical users by registering listeners for a set of basic commands that cover simple text-editing behavior such as entering text, deleting characters, copy + paste, or changing the selection with arrow keys. It also provides default behavior for rich text features, such as headings, formatted, text and blockquotes.

You can use this package as a starting point, and then add additional command listeners to customize the functionality of your editor. If you don't want or need rich text functionality, you may want to consider using [@lexical/plain-text](https://lexical.dev/docs/packages/lexical-plain-text) instead.

## Quotes: `QuoteNode` or `QuoteContainerNode`

The package has two quote nodes. Both render as a `<blockquote>` with the
theme's `quote` class.

| | `QuoteNode` | `QuoteContainerNode` (experimental) |
| --- | --- | --- |
| JSON type | `quote` | `quote-container` |
| Holds | inline content: one block of text, lines separated by line breaks | blocks: paragraphs, headings, lists, code, other quotes |
| Declares in `$config()` | `children: 'inline'` | `children: 'block'` |
| Shadow root | no (unless the `shadowRoot` state is set) | always |
| Enter | leaves the quote: a paragraph after it | splits the block the caret is in; the caret stays in the quote |
| Backspace at its start | the quote becomes a paragraph | the quote is dissolved, and its blocks stay in its place |
| Registered by | `RichTextExtension` | `QuoteContainerExtension` |

Use `QuoteNode` for a quote that is one passage of text, which is what the
toolbar of most editors makes, and what `RichTextExtension` gives every
editor.

Use `QuoteContainerNode` when a quote has structure: several paragraphs, a
list, a code block, a quote inside a quote (Markdown `> - item`, an email
reply, a `<blockquote>` with `<p>`s in it). It is a shadow root, like a table
cell: the selection, the arrow keys and the block commands (`$setBlocksType`,
`$insertList`) work on the blocks inside it.

`QuoteNode` can also hold blocks, by setting its `shadowRoot` state
(`$createQuoteNode({shadowRoot: true})`), but its class still declares
`children: 'inline'`, so code that reads the declaration has to special-case
it. In particular, `@lexical/y` stores such a quote as one line of text and
its paragraphs as nodes inside that line, and a collaborator's typing can be
lost when someone else splits or joins those paragraphs. `QuoteContainerNode`
declares what it holds, so `@lexical/y` stores it as a container, as it
stores a table cell. Prefer it for new code that needs blocks in a quote.

### Using it

`QuoteContainerExtension` registers the node next to `QuoteNode`; nothing
creates one unless you ask:

```ts
import {DOMImportExtension} from '@lexical/html';
import {
  $createQuoteContainerNode,
  QuoteContainerExtension,
  QuoteContainerRule,
} from '@lexical/rich-text';
import {
  $createParagraphNode,
  configExtension,
  defineExtension,
} from 'lexical';

const QuotesExtension = defineExtension({
  dependencies: [
    QuoteContainerExtension,
    // Optional: <blockquote> HTML imports as a container.
    configExtension(DOMImportExtension, {rules: [QuoteContainerRule]}),
  ],
  name: '@app/quotes',
});

// In an update:
$createQuoteContainerNode().append($createParagraphNode());
```

For Markdown, put `QUOTE_CONTAINER` in place of `QUOTE` in the transformers
of `@lexical/markdown`, or add `MdastQuoteContainerExtension` with
`@lexical/mdast`. Both export every block a container holds. Only
`@lexical/mdast` imports them all (CommonMark: a block quote holds any
blocks); `@lexical/markdown` reads a quote line by line, so it imports the
paragraphs of a quote and reads any other block in it (`> - item`) as text.
Use `@lexical/mdast` where Markdown may carry lists, headings or code inside
a quote (an agent's Markdown, for instance).

### One quote type for the whole editor

`QuoteContainerNode` extends `QuoteNode`, so an editor can replace one with
the other ([node replacement](https://lexical.dev/docs/concepts/node-replacement)).
`QuoteContainerReplacementExtension` does it:

```ts
const editor = buildEditorFromExtensions(
  defineExtension({
    dependencies: [RichTextExtension, QuoteContainerReplacementExtension],
    name: '@app/editor',
  }),
);
```

which is the same as listing the replacement in an editor's `nodes`:

```ts
nodes: [
  QuoteContainerNode,
  {
    replace: QuoteNode,
    with: () => $createQuoteContainerNode(),
    withKlass: QuoteContainerNode,
  },
]
```

Then `$createQuoteNode()`, the `<blockquote>` import (HTML and paste), the
Markdown `>` (`QUOTE`, `@lexical/mdast`) and JSON of type `quote` all build a
`QuoteContainerNode`, and `$isQuoteNode` is true for it. JSON saved before
loads: a `quote` with inline children gets them in a paragraph, and a `quote`
with `shadowRoot: true` keeps its blocks.

The editor saves what it loaded as `quote-container`. An editor that does not
register `QuoteContainerNode` (an older build, a server that renders the
JSON) cannot read that, so ship the node everywhere the documents are read
before turning the replacement on. A document shared through `@lexical/y`
or `@lexical/yjs` stores the node type too: do not turn the replacement on
for a shared document that already holds `quote` nodes without converting
it first. With `@lexical/y`, convert by reseeding the room from its JSON
(with the replacement registered, and `schemaVersion` bumped): `quote`
JSON loads as containers, and the seed stores them as containers. A client
with the replacement that meets a room still holding `quote` lines opens it
read only.

A block-type toolbar that turns a quote back into paragraphs with
`$setBlocksType(selection, $createParagraphNode)` changes the blocks the
selection is in, which are inside the container, so the container stays.
To take the blocks out of the quote, replace the container with its
children, for example with `$unwrapNode(container)` from `@lexical/utils`;
Backspace at the start of its first block does the same.

An empty container gets an empty paragraph when an edit leaves it empty.
Two collaborators who each remove a different block of the last two at
once each leave one locally, so no edit empties it, and the shared document
ends with an empty container (a read of a collaborator's change runs no
transforms). It stays editable: a caret placed in it and typing make the
paragraph.

