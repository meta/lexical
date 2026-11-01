---
'@lexical/table': patch
---

[fix] Leave a cut whose range has no end in a table to the editor's own cut and to other CUT_COMMAND listeners, instead of the table answering every range selection once the document holds a table
