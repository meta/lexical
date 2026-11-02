---
'@lexical/markdown': patch
---

[fix] Export formatted text that ends or starts with punctuation next to a letter as Markdown that keeps its format: the letter goes out as a numeric character reference

Verify: bold `Hello,` followed directly by plain `world` exports as `**Hello,**&#119;orld` (was `**Hello,**world`, which `$convertFromMarkdownString` and other CommonMark parsers read as literal asterisks) and imports as the same bold and plain text; `x` followed by italic `(beta)` exports as `&#120;*(beta)*`. Text with white space or a letter on both sides of the tags exports as before.
