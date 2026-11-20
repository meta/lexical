---
'@lexical/y': patch
---

[fix] A delete keeps every format item it leaves, so a comment or format a concurrent write or an undo restores ends where it ended instead of running on

A document now keeps two format items for each formatted run whose text is deleted; see "Deleted formatted text" in the collaboration docs' Limits.

Verify: comment a word, type plain text inside it on one client, and on another client that has not seen it delete the word with its neighbours, then the space after; after syncing (and undoing either edit), the comment covers only what it covered, never the following words or line.
