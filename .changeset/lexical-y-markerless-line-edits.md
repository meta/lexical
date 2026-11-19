---
'@lexical/y': patch
---

[fix] Leave a line without a marker as it is when a collaborator edits elsewhere in its container, and keep a caret on it

A line without a marker (text typed into a block a collaborator removed)
that a block node follows was given a marker by any Enter in its container,
so two clients pressing Enter at once added an empty paragraph, and a caret
on that line went to the end of the line before. Such a line is now left as
it is by edits elsewhere, as `y.md` describes, and a caret on it stays on it
when it does get a marker.

Verify: with a line without a marker before a table (text typed into a
block a collaborator removed while another appended a table), a
collaborator's Enter in a line above adds no empty paragraph, and your next
character on that line stays on it.
