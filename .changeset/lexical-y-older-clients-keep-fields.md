---
'@lexical/y': patch
---

[fix] Keep the fields a newer version of a node class added when a client with the older class edits the node in `@lexical/y`

A client writes and deletes only the fields its classes declare in `$config`, with the text formats and NodeState it holds, and keeps every other stored name. A client that does not register a link class (or `LinkNode`) a document uses opens it read only, as it does for every other node type it does not register.
