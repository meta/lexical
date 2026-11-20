---
'@lexical/table': patch
---

[fix] Pad the rows of a table again when an edit removes cells from some of its rows, such as a rich paste over a selection across cells that hold lists, so the table keeps a full grid. Only the rows that lost cells in the edit are padded: rows that gained cells (a column insert, an app's own row padding) and short rows the edit did not touch (a table ragged by collaborators' concurrent row and column inserts) are left to their authors

Verify: select from the middle of one cell to the middle of a cell in the next row, in a table whose cells hold lists, paste HTML that holds a list, and check that every row keeps as many cells as the table has columns (the padding cells are appended at the end of the rows that lost cells, as before).
