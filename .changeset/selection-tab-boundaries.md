---
'@lexical/selection': patch
---

[fix] Exclude unselected tabs at selection boundaries when copying or exporting

Verify: Copy or export a selection that ends immediately before a tab or starts immediately after one. The unselected tab should be omitted, while tabs within the selection should be preserved.
