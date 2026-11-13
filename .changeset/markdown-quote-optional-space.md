---
'@lexical/markdown': patch
---

[fix] Support block quotes without space after `>` and export blank quote lines as `>`

Verify: Blank quote lines within a blockquote now export as `>` instead of `> `, unspaced quote lines like `>text` are recognized on import, and paragraph lines starting with `>` (including partial selections and lines following soft breaks) are escaped on export to round-trip cleanly as paragraphs. Markdown saved by earlier versions from a paragraph beginning with `>` (such as `>5 items`) now loads as a quote per CommonMark §5.1. A custom transformer spreading `QUOTE` or reusing `QUOTE.regExp` with its own `replace` handler inherits or should decline `match[0] === '>'` outside import (`!isImport`) to preserve shortcut behavior on Enter.

