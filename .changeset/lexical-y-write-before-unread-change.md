---
'@lexical/y': patch
---

[fix] Write a local update still waiting for its commit when a remote change arrives in the same task on the document it was made on, so its edits no longer land at shifted offsets or undo the remote change

Verify: with a provider that applies a remote change in the same task as local updates made without `discrete: true` (a server, a test harness that delivers synchronously), the local edits land where they were made, the remote change is kept, and the selection stays where the local updates left it.
