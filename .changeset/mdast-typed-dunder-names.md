---
'@lexical/mdast': patch
---

[fix] Typing the closing `__` of a run around one word of ASCII letters, digits and underscores, such as `__init__` or `__main__`, leaves it as typed instead of turning it into a bold word

Verify: with `MdastShortcutsExtension`, type `the __init__ file`; the underscores stay. `**init**`, `__two words__` and `_init_` still convert, and Markdown import is unchanged. Only the construct that closes at the caret is checked, so a name inside another construct, such as `*the __init__*`, still loses its underscores when the outer delimiter is typed, as before.
