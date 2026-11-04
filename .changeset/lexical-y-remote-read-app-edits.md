---
'@lexical/y': patch
---

[fix] An edit an app's code makes in the update of a remote change's read is stored, and that update runs no node transforms

Lexical goes on in the update the binding reads a remote change in, after the read: it runs the selection's `TextNode#selectionTransform` and the updates queued behind the read. An app's code there that edited the document committed its edit in the read's commit, tagged as a remote change, which the binding does not write: the editor showed the edit, and the document, every peer and a fresh reader did not. The binding now writes what differs from what its read left, as a change of this client's that is not in the undo history (while read only, it reads those nodes again). Where a `selectionTransform` moved the caret, Lexical also extended the read's commit with `SELECTION_CHANGE_COMMAND` and ran every node transform over what the read brought, unwritten; the command is now dispatched once the read has committed, in an update of its own, as it already was where the read moved the caret.

Verify: in an editor with a DOM root, an app's `selectionTransform` that edits another paragraph while a remote change is read; the editor, a fresh reader of the document and every peer show the edit. A `SELECTION_CHANGE_COMMAND` handler that runs because a `selectionTransform` moved the caret in a read now runs after the read has committed, in an update of its own whose edits are the user's (in the undo history), and node transforms no longer run over a read's changes then.
