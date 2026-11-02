---
'@lexical/y': patch
---

[fix] After a write with a lone surrogate half is read again in `@lexical/y`, typing over a range formatted from inside an emoji keeps the formatted node's format and re-reads only the touched line in place

Verify: in `ab😀cd`, set a range selection `[3, 6)` or `[2, 3)` and format it bold, then type `Z` over the selection; `Z` is bold, matching plain Lexical, and in a multi-line document only the touched line is re-read.
