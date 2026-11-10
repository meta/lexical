---
'@lexical/y': patch
---

[fix] A binding disposed and started again writes edits inside a container it had read before (a box's text, a table cell's, a layout column's): they showed in the editor and reached no peer. It also shows collaborators' edits there again, and an unregistered node type that was removed while it was stopped no longer leaves it read only (one still in the document reports `UNKNOWN_NODE_TYPES_WARNING` again and keeps it read only).

Verify: call `dispose()` and then `start()` on a binding (or remount `YCollabExtension`'s editor with the same binding), type inside a table cell or another container, and check that a second client shows the edit; restart the second client instead and check the same.
