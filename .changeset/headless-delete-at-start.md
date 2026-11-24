---
'lexical': patch
---

[fix] Backspace at the start of the first block collapses it in a headless editor instead of throwing `window object not found`, and `RangeSelection.modify` no longer throws when the editor has no window
