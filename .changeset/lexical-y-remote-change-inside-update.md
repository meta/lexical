---
'@lexical/y': patch
---

[fix] A remote change applied while the editor makes a local update no longer loses that update: it is read right after the update has committed and been written, in a commit of its own

A provider that applies a remote change to the document from inside `editor.update()` (a synchronous provider between editors on one page, a test, an app calling `Y.applyUpdate` in an update or a command) made the binding read the change inside that update: the read replaced the lines it touched with what the document stored, which did not have the update's edits yet, and the commit took a collaborator's tags, so nothing of the update was written. Text typed in that update was lost, in the editor and in the document. Such a change is now read once the update has committed and been written, in a commit of its own tagged as a collaborator's change, right after it.

Verify: inside `editor.update()`, type text and apply a remote change to the document (`Y.applyUpdate`); after the update the editor and every client show both, and update listeners see the local commit, then the remote one.
