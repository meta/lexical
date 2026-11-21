---
'lexical': patch
---

[fix] Typing with a toggled format or style inside a segmented text node (such as a mention) formats only the typed text instead of the whole node

Verify: put the caret inside a mention or other segmented text, toggle bold and type, also with an IME; only the typed text is bold and the rest keeps its format.
