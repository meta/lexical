---
'@lexical/selection': patch
---

[fix] `$wrapNodes` keeps nested content in order when a block holds text directly next to its blocks

Verify: Wrap a selection across text and nested blocks in a custom element without a declared structure. The update should finish, keep the content in its original order, and leave the selection attached. Nested blocks, including empty blocks, should stay inside one new wrapper rather than becoming separate sibling wrappers.
