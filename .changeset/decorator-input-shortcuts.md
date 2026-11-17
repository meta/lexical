---
'lexical': patch
---

[fix] Keyboard shortcuts such as Ctrl+Backspace, Cmd+A, Cmd+B and Cmd+Z pressed in a text input or textarea inside a decorator node now act on that input instead of running the editor's command

Verify: keyboard shortcuts (Mod+Z, Mod+A, Ctrl/Alt+Backspace, Mod+B) pressed in a text input or textarea inside a decorator; the editor's undo and formatting no longer run for them.
