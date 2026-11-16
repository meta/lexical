---
'@lexical/overflow': patch
'lexical': patch
---

[fix] `OverflowNode` is an inline node, so text past the character limit stays on the same line, and a block that ends in an inline element whose last child is a line break shows its empty last line
