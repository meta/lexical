---
'@lexical/rich-text': patch
---

[fix] Typing after a selected block decorator inserts text immediately after it, including in Firefox and WebKit

Verify: Select a horizontal rule by clicking it or arrowing onto it, then type, including an Option-generated character on macOS or an AltGraph character. Text should appear immediately after it, reusing an empty following paragraph or heading or inserting a paragraph before existing text. Cancelled key events, modifier shortcuts, and keyboard input in embedded controls and nested editors should retain their normal behavior.
