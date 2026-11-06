---
'@lexical/mdast': patch
---

[fix] `MdastTableExtension` gives a table cell added in the editor (an inserted row, or a cell split from a merged cell) its column's GFM alignment

Verify: rows inserted into, and cells unmerged in, tables whose columns are aligned in Markdown. A table that is imported, loaded from a saved editor state, or pasted outside a table keeps the formats it comes with. When a table is pasted into an existing table, the rows the paste adds take their column's alignment, while the pasted cells that land on existing rows keep the formats they come with.
