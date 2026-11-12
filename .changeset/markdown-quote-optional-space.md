---
'@lexical/markdown': patch
---

[fix] Support block quotes without space after `>` and export blank quote lines as `>`

Verify: Blank quote lines within a blockquote now export as `>` instead of `> `, and unspaced quote lines like `>text` are recognized on import.
