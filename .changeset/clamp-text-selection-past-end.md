---
'lexical': patch
---

[fix] Clamp RangeSelection text points when shrinking a TextNode with spliceText or setTextContent, preventing out-of-bounds selection errors

Verify: when a `TextNode` is shrunk via `spliceText(offset, delCount, '')` (without `moveSelection`) or `setTextContent(shorter)`, selection points targeting the node that exceed the new text length are clamped to the node's bounds. Both in-update operations and the commit validation pass in `$beginUpdate` ensure that committed text selection offsets never exceed `getTextContentSize()`, preventing dev-mode assertions from failing during subsequent `splitText` operations.
