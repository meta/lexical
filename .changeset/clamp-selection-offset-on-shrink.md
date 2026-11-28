---
'lexical': patch
---

[fix] A text selection point left past the end of its node, after the node is shortened with `setTextContent` or `spliceText` (without `moveSelection`), is clamped to the node's end when the pending editor state is committed (once per commit, so queued updates that share it still see the offsets they set), so later operations such as `splitText` no longer throw

Verify: after shrinking a text node with `spliceText` (without `moveSelection`) or `setTextContent` while the selection is inside it, the committed selection offsets stay within the node's text.
