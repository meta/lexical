---
'@lexical/table': patch
---

[fix] Arrow keys at a soft wrap in a table cell move to the right line or cell

Verify: in a table cell whose text wraps, put the caret at the start of the last visual line and press ArrowDown: it moves to the cell below. Put it at a wrap boundary and press ArrowUp: it moves up one visual line instead of jumping out of the table. Home, End and clicks on either side of the wrap keep their behavior.
