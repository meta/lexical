---
'@lexical/markdown': patch
---

[fix] Import emphasis and code spans that continue across a soft line break

Verify: import `**a\nb**` and check it gives bold `a`, a line break and bold `b` (exported as `**a**\n**b**`). Lines of a paragraph, quote or list item are parsed together only while a delimiter is still open, so a custom text-match transformer sees the joined lines (separated by `\n`) only in that case.
