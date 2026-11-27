---
'@lexical/mdast': patch
---

[fix] Join touching strikethrough from export rules and inline decorators when exporting Markdown

Verify: With an export rule for `TextNode` that adds `data` to each `delete` node `context.next()` returns, strikethrough `a` followed by strikethrough bold `b` should export as `~~a**b**~~` and read back as the same texts and formats (before, `~~a~~~~**b**~~`, which reads back as one strikethrough of `a~~~~` and bold `b`). `$convertToMdast()` still returns two `delete` nodes, and a `delete` handler of your own still gets both.
