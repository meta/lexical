---
'@lexical/table': patch
---

[fix] Keep a table's `<col>` elements when its column widths change, so a table sized by its content (`width: max-content`, or a grid `max-content` track) shrinks when its columns are narrowed instead of keeping its old width and horizontal scrollbar until it is laid out again

Verify: narrowing a table's columns (a column resize, or `setColWidths`) updates the `<col>`s already rendered instead of replacing them; a column whose width is `0` or missing has a `<col>` without a `style` attribute, as before. Code that held a reference to a table's `<col>` elements now keeps a live one.
