---
'@lexical/table': patch
---

[fix] Building an editor no longer throws `Expected to find TableElement in DOM` when the editor state already holds a table before `TableExtension` registers, for example when an extension listed earlier (such as `YCollabExtension` on a document that holds a table) sets the content in its `register`; the table's selection handling attaches when the table is rendered
