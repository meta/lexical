---
'@lexical/y': patch
---

[fix] Write text holding a lone surrogate half in `@lexical/y` like any other text, so a selection set inside an emoji no longer throws and the author shows the same U+FFFD as every other client

Verify: set a range selection with one end between the two halves of an emoji (`anchor.set(key, 3, 'text')` in `ab😀cd`) and bold, type or delete; nothing throws, the author, every other client and a reload show the edit applied with U+FFFD in place of each half of the emoji, and undoing it brings the emoji back.
