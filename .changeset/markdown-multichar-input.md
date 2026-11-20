---
'@lexical/markdown': patch
---

[fix] Apply Markdown shortcuts to multi-character text input

Verify: Insert a Markdown list or heading marker, or complete inline formatting, in one text-input event, as with dictation or predictive text. Confirm the shortcut converts, undo restores the literal Markdown, and redo restores the conversion. Separate multi-character programmatic updates retain the heuristic. A non-discrete scripted update made synchronously after scripted native input can join its pending commit and share its input tag, so its Markdown may also convert. Pasting a single trigger character (such as a space after `#`) now leaves the marker literal instead of converting it.
