---
'@lexical/y': patch
---

[fix] A binding releases, when it stops, the keeps it set again after a clear of its undo history: the containers of text it formatted in a table cell after deleting there are no longer kept for the document's life

Verify: in a table cell, delete a character, then bold some text in the same cell, then clear the undo history and stop the binding: no item of the document stays kept, and a collaborator's later delete of the table is collected. While the binding is bound, another undo manager on the document can still undo what it tracked.
