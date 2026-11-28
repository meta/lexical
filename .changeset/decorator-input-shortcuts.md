---
'lexical': patch
---

[fix] Keyboard shortcuts such as Ctrl+Backspace, Cmd+A, Cmd+B and Cmd+Z pressed in a text input, textarea or foreign contentEditable inside a node's DOM (such as a decorator's input) now act on that input instead of running the editor's command

Verify: keyboard shortcuts (Mod+Z, Mod+A, Ctrl/Alt+Backspace, Mod+B) pressed in a text input or textarea inside a decorator or a node's unmanaged DOM; the editor's undo and formatting no longer run for them, and in Chromium and WebKit an undo in an input with nothing to undo no longer undoes the editor's text. A checkbox or button in a decorator keeps the editor's shortcuts.
