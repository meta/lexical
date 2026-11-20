---
'@lexical/markdown': patch
---

[fix] Apply Markdown shortcuts to multi-character text input

Verify: Insert a Markdown list or heading marker, or complete inline formatting, in one text-input event, as with dictation or predictive text. Confirm the shortcut converts while multi-character programmatic updates remain unchanged. Pasting a single trigger character (such as a space after `#`) now leaves the marker literal instead of converting it.
