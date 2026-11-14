---
'@lexical/markdown': patch
---

[fix] Copy only the selected part of a code block when exporting a selection to Markdown

Verify: Select part of a code block and use Copy as Markdown. The fenced block should contain only the selected text, with its whitespace and language preserved.
