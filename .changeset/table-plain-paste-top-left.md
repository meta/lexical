---
'@lexical/table': patch
---

[fix] Plain text pasted into a table selection made right to left or upwards starts at the selection's top-left cell, so it no longer overwrites cells outside the selection

A table selection keeps the cell it was started from as its anchor. Pasting plain text (tab- and newline-separated values, as "paste and match style" delivers it) spread the values from that anchor, so a selection made from its right or bottom end put them to the right of or below the selection, over cells it did not hold, and grew the table. The values now start at the top-left cell of the selection's rectangle whichever way it was made, as they already did for a selection made from its top-left cell and as a pasted table does. Pasted content without a table that becomes such a grid (several paragraphs of HTML) is placed the same way. A single value, and a paste into a single selected cell, still go to the cell the selection was started from.

Verify: in a table, select three cells of a row by dragging from the right one to the left one, paste `X`, tab, `Y`, tab, `Z` as plain text, and check that the three selected cells hold X, Y and Z and the cell to their right keeps its text.
