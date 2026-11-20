---
'@lexical/mdast': patch
---

[fix] With `MdastGfmExtension` or `MdastAutolinkLiteralExtension`, export escapes the `.` of `www.` in text whatever follows it, also where an inline element with no export rule, such as a `MarkNode`, splits the `www`, so the characters after it are read back as typed

Text that such an element splits is escaped as one text in general, so `1` before a mark of `. x` is written as `1\. x` instead of starting an ordered list.

Verify: export snapshots of text with `www.` before the marker of a format or a link, before a non-ASCII character beside formatting, or before punctuation that the export escapes, such as `www\.**x**` (formerly `www.**x**`), `www\.&#x4E16;**!**` (formerly `www.&#x4E16;**!**`, which was read back as a link to `http://www.&#x4E16`, then `;` and `!`) or `www\.\*x` (formerly `www.\*x`). Plain `www.example.com` was written as `www\.example.com` already. A custom `text` handler in `toMarkdownExtensions` now receives adjacent texts that have nothing set but their value as one text, such as plain text that an inline element with no export rule splits, or a text that an export rule returns beside other text, so check its output for such text.
