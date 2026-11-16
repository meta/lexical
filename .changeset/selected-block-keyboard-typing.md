---
'@lexical/rich-text': patch
---

[fix] Keep the first character typed after a selected block decorator in Firefox and WebKit

Verify: Select a divider and type, including an Option-generated character on macOS or an AltGraph character. Text should appear immediately after it, reusing an empty following block or inserting a paragraph before existing text. Modifier shortcuts and keyboard input in embedded controls and nested editors should retain their normal behavior.
