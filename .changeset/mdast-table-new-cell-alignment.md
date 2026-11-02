---
'@lexical/mdast': patch
---

[fix] `MdastTableExtension` gives a table cell added in the editor (an inserted row, or a cell split from a merged cell) its column's GFM alignment

Verify: rows inserted into, and cells unmerged in, tables whose columns are aligned in Markdown. A table that is imported, loaded from a saved editor state or pasted keeps the formats it comes with.
