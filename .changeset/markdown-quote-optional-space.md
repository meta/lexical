---
'@lexical/markdown': patch
---

[fix] Support block quotes without space after `>` and export blank quote lines as `>`

Verify: Blank quote lines within a blockquote now export as `>` instead of `> `, unspaced quote lines like `>text` are recognized on import, and paragraph lines starting with `>` are escaped on export to round-trip cleanly as paragraphs. A custom transformer reusing `QUOTE.regExp` with its own `replace` handler should decline `match[0] === '>'` outside import (`!isImport`) to preserve shortcut behavior on Enter.

