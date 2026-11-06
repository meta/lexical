---
'@lexical/y': patch
---

[fix] Undoing an edit made inside a collaborator's NodeState value no longer spreads that value over the rest of the document

Verify: with three clients, set an object NodeState value on part of a line, have another client type inside it offline while the first undoes it, then set the value again over a range that ends at that typing, and undo the typing; the next lines, the last one included, carry no value on any client or a fresh reader.
