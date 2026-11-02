---
'@lexical/y': patch
---

[fix] An undo puts a format or comment back only where it was, also after a collaborator deleted or retyped around it, with Yjs's default garbage collection

Verify: comment a word on one client, remove the comment on another, undo on the first and then on the second (syncing after each step), with documents made by `createYDoc()`: the comment comes back on that word or nowhere, never over the following paragraphs.
