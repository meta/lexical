---
'@lexical/rich-text': patch
'@lexical/markdown': patch
'@lexical/mdast': patch
---

[feature] Add `QuoteContainerNode` (experimental), a quote that holds blocks and declares it

`QuoteContainerNode` (`@lexical/rich-text`, JSON type `quote-container`) is a `<blockquote>` that holds paragraphs, headings, lists, code and other quotes. Its class declares `children: 'block'` and is always a shadow root, so `BlockIdExtension`, `NodeStructureExtension` and `@lexical/y` treat it as a container with no special case; `@lexical/y` stores it as it stores a table cell, where a `QuoteNode` with the `shadowRoot` state is stored as one line. It extends `QuoteNode`, whose behavior and JSON are unchanged.

- `@lexical/rich-text`: `QuoteContainerNode`, `$createQuoteContainerNode`, `$isQuoteContainerNode`, `SerializedQuoteContainerNode`, `QuoteContainerExtension` (registers the node), `QuoteContainerReplacementExtension` (replaces `QuoteNode` with it, so `$createQuoteNode()`, `<blockquote>`, Markdown `>` and JSON of type `quote` all build a container) and `QuoteContainerRule` (opt-in `<blockquote>` import rule).
- `@lexical/markdown`: `QUOTE_CONTAINER`, to use in place of `QUOTE`. `QUOTE` builds a container where `QuoteNode` is replaced, and exports one with every block behind `> `. `QUOTE` and `QUOTE_CONTAINER` now match a bare `>` line too (`regExp` is `/^>(\s|$)/`, was `/^>\s/`): in a container it is the blank line between two paragraphs, and anywhere else it is kept as text, as before. Known limit: `@lexical/markdown` imports only the paragraphs of a quote into a container (`> - item` is read as text); `@lexical/mdast` imports every block. An element transformer's `export` is given a fourth, optional argument, `traverseBlocks`, which exports a node's children as blocks.
- `@lexical/mdast`: `MdastQuoteContainerExtension`, to import blockquotes as containers. The default blockquote handler and the `> ` shortcut build a container where `QuoteNode` is replaced.
