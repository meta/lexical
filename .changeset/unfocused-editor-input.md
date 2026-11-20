---
'lexical': patch
---

[fix] Prevent stale native editor carets from accepting input intended for another focused surface in WebKit

Verify: Type in an editor, move focus to a surface that preserves the native caret (such as a canvas), then type or press Backspace. The editor content and outside focus should remain unchanged. Explicit editor updates from toolbar controls should still edit and focus the editor.

Application `BEFORE_INPUT_COMMAND` handlers no longer receive these rejected insertions and deletions while another control owns focus. Verify that undo/redo from an outside field (such as a link URL input) still use the editor history, and that `historyUndo`, `historyRedo` and `insertFromDrop` continue to reach application handlers.
