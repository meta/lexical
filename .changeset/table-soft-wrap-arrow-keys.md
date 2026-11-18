---
'@lexical/table': patch
---

[fix] Arrow keys at a soft wrap in a table cell move to the right line or cell

Verify: in a table cell whose text wraps, put the caret at the start of the last visual line and press ArrowDown: it moves to the cell below. Put it at a wrap boundary and press ArrowUp: it moves up one visual line instead of jumping out of the table. In a first-row cell with nothing above the table, ArrowUp from the end of the first line moves to the start of that line and a second press leaves the table. In a last-row cell, ArrowDown at a wrap boundary exits below the table, to the start of the block after it. Home, End and clicks on either side of the wrap keep their behavior.
