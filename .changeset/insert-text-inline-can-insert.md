---
'lexical': patch
---

[fix] `RangeSelection.insertText` keeps text inside an inline element that accepts it at its edge

Verify: typing, retyping a selection, or composing at the start or end of a custom inline `ElementNode` that keeps the default `canInsertTextBefore()`/`canInsertTextAfter()`: the text now stays inside the element, as it did before v0.49.0. Return `false` from those methods to keep it outside, as `LinkNode` and `MarkNode` do.
