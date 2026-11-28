---
'@lexical/extension': patch
'@lexical/react': patch
---

[fix] `maxIndent` of `TabIndentationExtension` and `TabIndentationPlugin` also limits indentation that arrives by paste, in the initial state or from code, not only by the Tab key

Verify: with `maxIndent` set, paste a list nested deeper than the limit, or open a saved document that has one, and check it stops at `maxIndent - 1`; a check or numbered sublist past the limit joins its parent list.
