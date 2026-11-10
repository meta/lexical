---
'lexical': patch
---

[fix] `RangeSelection.insertText` respects `canInsertTextBefore()`/`canInsertTextAfter()` of an inline element again: text typed at the start or end of an inline element that allows it, or replacing text at its edges, stays inside the element instead of being placed next to it (replacing all of its text left it empty). Inline elements that refuse text, such as links, are unchanged
