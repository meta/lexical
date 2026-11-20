---
'@lexical/table': patch
---

[fix] A table selection on a cell whose row span reaches past the last row no longer throws

The table commands keep row spans within the table, but a remote update (for example, one collaborator merging cells down to the last row while another deletes a row) or imported JSON can leave a cell spanning past the last row. Setting a table selection on such a cell threw (`TableSelection.getNodes` read rows that do not exist), so the cell could not be selected, deleted or copied. The rectangle a table selection covers now stops at the table's last row, as the table map and the rendered table already do, and extending or shrinking it with Shift and an arrow key counts only the rows such a cell covers; the cell's row span is not changed (a copy keeps it). Inserting or deleting rows, merging, unmerging and plain-text paste on such a selection still throw (#9759).

Verify: build a four-row table whose first cell has `rowSpan` 5 (for example in an update with `skipTransforms`, as a remote update applies it), select that cell with `$createTableSelectionFrom`, and call `getNodes()` or press Delete; neither throws.
