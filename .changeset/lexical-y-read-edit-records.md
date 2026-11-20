---
'@lexical/y': patch
---

[fix] An app's edit in a remote change's read is written with the update's own record of what it moved, as a local update is: a move made there no longer rewrites the lines it passed, so a collaborator's characters in them keep their items (they were deleted and written again as the local client's, which could undo a concurrent edit of theirs); development builds report another client's insertions inside the binding's own write transaction, which is unsupported (`RAW_YJS_WRITE_WARNING`, reason `'remote-in-write'`; remote deletions there, and updates applied inside an app's outer transaction, are not detected)

Verify: have a collaborator type in a short line, then, from an app's selection transform in a read of another change, move a longer line past it; the collaborator's character keeps its Yjs item on every client and a fresh reader.
