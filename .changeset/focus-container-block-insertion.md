---
'@lexical/utils': patch
---

[fix] Insert blocks into the focus cell of a table selection so they are not lost in tables with missing cells

Verify: select cells in a table with a missing cell beside a cell spanning multiple rows, then call `$insertNodeToNearestRoot` and check that the inserted block remains inside the focus cell after the update. Both forward and backward selections insert into the focus cell, including in regular and nested tables, and preserve existing cell content. The cell now ends with the inserted block, without a trailing empty paragraph; typing after it still works.
