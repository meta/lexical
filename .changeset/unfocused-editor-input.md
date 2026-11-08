---
'lexical': patch
---

[fix] Prevent stale native editor carets from accepting input intended for another focused surface in WebKit

Verify: Type in an editor, move focus to a surface that preserves the native caret (such as a canvas), then type or press Backspace. The editor content and outside focus should remain unchanged. Explicit editor updates from toolbar controls should still edit and focus the editor.
