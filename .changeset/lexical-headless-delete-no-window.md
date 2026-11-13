---
'lexical': patch
---

[fix] Backspace at the start of the first block no longer throws "window object not found" in an editor with no root element, such as a headless editor

Verify: in a headless editor, dispatch `DELETE_CHARACTER_COMMAND` with `true` at the start of a quote that is the root's first child: it becomes a paragraph instead of throwing.
