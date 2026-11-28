---
'@lexical/markdown': patch
---

[fix] Support block quotes without space after `>`

Verify: Unspaced quote lines like `>text` are now recognized on import per CommonMark §5.1, and paragraph lines starting with `>` (including partial selections and lines following soft breaks) are escaped on export to round-trip cleanly as paragraphs. Markdown saved by earlier versions from a paragraph beginning with `>` (such as `>5 items`), or any text passed to `$convertFromMarkdownString` that starts with `>` and a non-space character, now loads as a block quote after upgrading; prefixing with `\>` keeps it as text. A custom transformer spreading `QUOTE` or `QUOTE_CONTAINER` or reusing their `regExp` with its own `replace` handler inherits or should decline `match[0] === '>'` outside import (`!isImport`) to preserve shortcut behavior on Enter.
