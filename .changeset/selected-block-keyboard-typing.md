---
'@lexical/rich-text': patch
---

[fix] Keep the first character typed after a selected block decorator in Firefox and WebKit

Verify: Select a divider and type. Text should appear immediately after it, reusing an empty following block or inserting a paragraph before existing text. Modifier shortcuts and typing inside an embedded input should retain their normal behavior.
