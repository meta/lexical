---
'@lexical/mdast': patch
---

[fix] Keep a line that starts with four spaces as typed when Enter is pressed at its end, instead of replacing it with an empty code block

Verify: with `MdastShortcutsExtension`, type four spaces and a few words, then press Enter; the words stay. A ```` ```js ```` line followed by Enter still starts a code block.
