---
'@lexical/y': patch
---

[fix] A delete keeps every format item it leaves, so a comment or format a concurrent write or an undo restores ends where it ended instead of running on

Verify: comment a word, type plain text inside it on one client, and on another client that has not seen it delete the word with its neighbours, then the space after; after syncing (and undoing either edit), the comment covers only what it covered, never the following words or line.
