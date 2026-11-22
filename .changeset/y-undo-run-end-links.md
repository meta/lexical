---
'@lexical/y': patch
---

[fix] An undo that ends a restored run keeps the document's item list linked: the client that undid no longer holds an item a walk of its list skips, which could make its editor stop matching its document

Verify: two clients synced after every step; one deletes two characters of a line, the other comments the end of one line and part of another and bolds part of a third, the first types " new " and deletes part of it, removes the first comment and undoes that. Every item's neighbours link back to it on both clients.
