---
'@lexical/mdast': patch
---

[fix] With `MdastAutolinkLiteralExtension`, export escapes the `.` of `www.` in text whatever follows it, so the characters after it are read back as typed: `www.世` before bold `!` was written as `www.&#x4E16;**!**` and read back as a link to `http://www.&#x4E16`, then `;` and `!`

Verify: export snapshots of text with `www.` before the marker of a format or a link, before a non-ASCII character beside formatting, or before punctuation that the export escapes, such as `www\.**x**` (formerly `www.**x**`), `www\.&#x4E16;**!**` (formerly `www.&#x4E16;**!**`) or `www\.\*x` (formerly `www.\*x`). Plain `www.example.com` was written as `www\.example.com` already.
