---
'@lexical/mdast': patch
---

[fix] A typed `*`, `**` or `~~` that closes a run opened in the middle of a word no longer converts it, so `2*3*4` and `x*y*z` stay as typed

Verify: with `MdastShortcutsExtension`, type `2*3*4`; the asterisks stay. `a *b*`, `(*b*` and `中文*强调*` still convert as before, and Markdown import is unchanged.
