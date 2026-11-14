---
'@lexical/markdown': patch
---

[fix] Import emphasis and code spans that continue across a soft line break

Verify: import `**a\nb**` and check it gives bold `a`, a line break and bold `b` (exported as `**a**\n**b**`), and import `` x `a\nb` y `` to get two code spans (exported as `` x `a`\n`b` y ``). Lines are parsed as one string only while an emphasis, code span or link text is open, so a custom text-match transformer sees a paragraph's lines joined by `\n` only then; every other line is imported on its own in its own block as before. If a transformer cannot run on the joined lines, they are imported one by one. Known limitation: the exporter does not escape `=`, so `a ==b` followed by a line `c== d` exports as text that imports as highlighted text; the same happens on a single line.
