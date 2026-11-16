---
'@lexical/extension': patch
'@lexical/react': patch
---

[fix] `maxIndent` of `TabIndentationExtension` and `TabIndentationPlugin` also limits indentation that arrives by paste, in the initial state or from code, not only by the Tab key
