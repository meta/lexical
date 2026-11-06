---
'lexical': patch
---

[fix] Keep the block cursor inside an element's DOM slot `before` boundary

Verify: in an ElementNode whose `getDOMSlot` returns `withBefore(...)`, put the caret after its last block decorator; the block cursor renders before the trailing decoration instead of after it.
