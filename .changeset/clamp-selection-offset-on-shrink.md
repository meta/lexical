---
'lexical': patch
---

[fix] Clamp RangeSelection points to the TextNode size when shrinking via `spliceText` or `setTextContent`, preventing out-of-bounds selection points from causing subsequent operations to throw.
