---
'@lexical/table': patch
---

[fix] Deleting a row no longer drops a merged cell that was changed earlier in the same update

`$deleteTableRowAtSelection` trims the row span of a merged cell that reaches past the deleted rows, and moves the cell down when the deleted rows include its first row. It read the cell's row span again after trimming it, and visited a cell spanning several deleted rows once per row. When the cell was already writable in the update (for example, `$mergeCells` and `$deleteTableRowAtSelection` called in one `editor.update`), the trim changed the cell in place: deleting the cell's first row removed the cell and its content instead of moving it, and deleting several rows under it trimmed the span more than once, leaving the table ragged. Each cell is now trimmed once, from the span it had before the delete. Deleting rows in their own update, as the table menu does, already worked and is unchanged.

Verify: in one `editor.update`, merge B1:B2 of a 2x2 table with `$mergeCells` and delete row 1 with `$deleteTableRowAtSelection`; the table is one row, `A2 | B1 B2`.
