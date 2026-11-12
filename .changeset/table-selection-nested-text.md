---
'@lexical/table': patch
---

[fix] The plain text of a table selection that holds a nested table has the nested table's text once, not twice

Verify: select a table whose cell holds a nested table and copy or cut it as plain text; the nested cell's text appears once, and the outer cells keep their rows and columns.
