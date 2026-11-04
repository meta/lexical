---
'@lexical/table': patch
---

[fix] A table selection in a table whose rows have different numbers of cells no longer throws (`Cannot destructure property 'cell' of 'map[i][j]'`), and deleting, copying or pasting it keeps the cells it does not hold

Such a ragged table can stay that way after collaborators insert a row and a column at the same time, or after loading JSON that has it. `TableSelection.getNodes()`, aligning a table selection and exporting a table to HTML now skip the grid positions that no cell covers, and a selected row with no cell of its own stays in the copy (a blank line in its plain text) when a later selected row has one, so rows keep their places when it is pasted. Deleting a table selection removes the table only when it holds every cell of the table, not whenever it holds the first and last cells, which also stops a rectangular table from being removed when a cell spanning rows in another column is not selected. A selection with a short first row holds a merged cell further right whole. Pasting a copied ragged selection takes the widest row and leaves a target cell at a position the pasted table has no cell for as it is.

Verify: in a table with rows of 2, 1, 3 and 2 cells, select from the first cell to the last, press Delete and check that the third cell of the third row keeps its text; copy and paste the selection into another table and check that nothing throws and the rows keep their places.
