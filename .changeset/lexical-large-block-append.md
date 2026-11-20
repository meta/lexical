---
'lexical': patch
---

[fix] Inserting into, splitting, or pressing Enter in a block with tens of thousands of children (past roughly 100,000 to 125,000 on V8's main thread, 65,536 on JavaScriptCore: a paragraph pasted from a text with that many line feeds) no longer throws `RangeError: Maximum call stack size exceeded`

Verify: in a paragraph of more than 130,000 text nodes and line breaks, press Enter after its first character, insert a paragraph at its end with `$insertNodes`, and call `$splitNode` on it; each moves the children as it does in a small paragraph, with no error.
