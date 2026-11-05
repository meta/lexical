---
'@lexical/y': patch
---

[fix] A write made inside an app's transaction that leaves the layout record newer than the binding reads, missing, malformed or (new) older than `MIN_LAYOUT` is no longer stored: an editor update, the binding's undo and redo (queued ones included, and those through `binding.undoManager`), initialization, the recovery of a failed write and pin writes check the record as it is when they write, inside their own transaction (after any `beforeTransaction` listener of the app, which may change it), instead of the status the binding last read; a schema record that a `beforeTransaction` listener makes newer or malformed at a write's start refuses it the same way (main stored such a write)

The same refusal applies when the record changes in the transaction for another reason, such as a remote layout change a provider applies while the editor is updating; its `UNSUPPORTED_EDIT_WARNING` message says so instead of naming an app's transaction. Such a refusal is reported with its own reason, `{reason: 'refused-at-write', record: 'layout' | 'schema'}`, not `'read-only'`: the binding may stay active afterwards (when the record is put back), and `'read-only'` keeps meaning an edit refused because the binding is read only.

Verify: inside `doc.transact`, delete the root's `lexical-y:<n>` records (or add a newer one) and append a paragraph through the editor, or call `binding.undo()`: nothing is stored, and once the transaction ends the binding is read only with `UNSUPPORTED_LAYOUT_WARNING`, as before. Previously the write was stored first.
