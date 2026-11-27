---
'@lexical/mdast': patch
---

[fix] Write the character references that cmark-gfm (GitHub) needs beside emphasis and strikethrough in a strict Markdown export

Verify: With the default `exportPunctuation: 'strict-commonmark'`, strikethrough `a` followed by italic code `b` should export as ``~~&#x61;~~*`b`*`` (before, ``~~a~~*`b`*``, which GitHub renders with literal asterisks, as cmark-gfm reads the `a` beyond the `~~` run), and `©` followed by `_a_` written by an export rule should export as `&#xA9;_a_` (before, `©_a_`, which GitHub renders with literal underscores, as cmark-gfm reads `©` as a letter). Both read back as the same texts and formats. Export `'cjk-friendly'` is unchanged.
