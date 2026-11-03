---
'@lexical/y': patch
---

[fix] A write made inside an app's transaction that leaves the layout record newer than the binding reads, missing, malformed or (new) older than `MIN_LAYOUT` is no longer stored: an editor update and the binding's undo and redo (queued ones included, and those through `binding.undoManager`) check the record as it is when they write, inside their own transaction (after any `beforeTransaction` listener of the app, which may change it), instead of the status the binding last read

Verify: inside `doc.transact`, delete the root's `lexical-y:<n>` records (or add a newer one) and append a paragraph through the editor, or call `binding.undo()`: nothing is stored, and once the transaction ends the binding is read only with `UNSUPPORTED_LAYOUT_WARNING`, as before. Previously the write was stored first.
