---
'@lexical/yjs': patch
---

[fix] Remove locally deleted types from the collab-v2 mapping so a peer's caret in a locally deleted block no longer throws in syncCursorPositions

Verify: with the v2 binding and an UndoManager, delete a paragraph that holds a remote caret, then run cursor sync; the caret is skipped instead of throwing "node does not exist in active editor state", matching the behavior for remote deletions.
