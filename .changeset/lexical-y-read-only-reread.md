---
'@lexical/y': patch
---

[fix] A client that is read only (a newer schema or layout, a node type it does not register) no longer stops showing a collaborator's changes after it refuses a local update that removed stored nodes (a table column's cells), and refuses, reads again and warns about an update an app's listener makes while the binding opens the document

Verify: open a document a newer schema wrote, run `$deleteTableColumnAtSelection`, then type in that column's cells from another client and check that the read-only client shows the text.
