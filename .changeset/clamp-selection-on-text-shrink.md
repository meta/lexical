---
'lexical': patch
---

[fix] Clamp committed selection points when a text node is shrunk

Verify: after `spliceText`/`setTextContent` shortens a selected text node, the committed selection sits at the node's new end and a following `splitText` no longer throws in dev.
