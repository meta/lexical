---
'@lexical/markdown': patch
---

[fix] A `QuoteNode` with the `shadowRoot` state exports to Markdown with each of its blocks behind `> `, a blank quote line between two, instead of their inline content run together on one line

Verify: `$convertToMarkdownString` of a shadow root quote holding paragraphs `one` and `two` now writes `> one\n> \n> two`, where it wrote `> onetwo`; a list or a heading in it is written as one. A `QuoteNode` without the state exports as before.

Also, with `shouldMergeAdjacentLines`, `normalizeMarkdown` keeps a bare `>` line inside a quote as a blank quote line instead of merging a `>` into the line before: `> a\n>\n> b` now imports as `quote("a" "\n" "\n" "b")` where it read `quote("a >" "\n" "b")`. A bare `>` outside a quote merges as before.
