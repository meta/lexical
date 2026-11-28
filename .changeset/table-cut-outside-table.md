---
'@lexical/table': patch
---

[fix] Leave a cut that isn't wholly in a table to the editor, after widening it over the table when it has an end in one

Verify: in a rich-text editor whose document has a table, select all and cut, or cut a range from a paragraph into a table cell. Everything removed, the whole table included, is on the clipboard, lower-priority `CUT_COMMAND` listeners run, and Undo restores the cut on its own. A table selection, or a range inside one cell, is still cut by the table.
