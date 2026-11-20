---
'@lexical/mdast': patch
---

[fix] With `MdastGfmExtension` or `MdastAutolinkLiteralExtension`, export escapes the `.` of `www.` in text whatever follows it, so the characters after it are read back as typed

Verify: export snapshots of text with `www.` before the marker of a format or a link, before a non-ASCII character beside formatting, or before punctuation that the export escapes, such as `www\.**x**` (formerly `www.**x**`), `www\.&#x4E16;**!**` (formerly `www.&#x4E16;**!**`, which was read back as a link to `http://www.&#x4E16`, then `;` and `!`) or `www\.\*x` (formerly `www.\*x`). Plain `www.example.com` was written as `www\.example.com` already.
