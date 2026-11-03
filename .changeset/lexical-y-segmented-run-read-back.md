---
'@lexical/y': patch
---

[fix] Show one token or segmented text node again after a format that split its stored run is removed, as every other client shows it

Verify: in a shared document, let a comment come back on part of a token or segmented node (an undo of its removal on another client) and remove it again: the client that removed it shows one node, as the other clients and a reload do.
