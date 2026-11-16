---
'@lexical/list': patch
---

[fix] Removing the last item of a nested list renumbers the items after its wrapper item, so a split there continues the numbering

Verify: in a numbered list "ff", "gg hh", indent "ff", then remove it: "gg hh" reads 2. (It read 1, and inserting paragraphs at the empty item started the list after them at 1.)
