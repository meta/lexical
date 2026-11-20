---
'@lexical/table': patch
---

[fix] Leave a cut whose range has no end in a table to the editor's own cut and to other CUT_COMMAND listeners, instead of the table answering every range selection once the document holds a table

Verify: in a document that holds a table, cut a range with neither end in the table (for example Select All over a heading, a table and a paragraph) and check that `CUT_COMMAND` listeners below `COMMAND_PRIORITY_HIGH` run, that the removal arrives in an update tagged `CUT_TAG` once the clipboard write resolves, and that an empty paragraph rather than an empty heading is left. In a document with two tables, cutting from a cell of the second table to the text after it removes that table whole.
