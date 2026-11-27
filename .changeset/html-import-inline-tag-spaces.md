---
'lexical': patch
---

[fix] Keep the spaces around `<strike>`, `<font>`, `<small>`, `<big>`, `<nobr>`, `<dfn>`, `<bdi>`, `<bdo>` and `<data>` when importing HTML, so pasted text such as `is <strike>old</strike> now` no longer becomes `isoldnow`

Verify: HTML import of text around these tags, for example pasted email, keeps one space on each side of them. `isInlineDomNode` from `lexical` and `@lexical/utils` now returns `true` for these tags, so `$generateNodesFromDOM` also turns an empty block between two of them into a line break, as it already did between two `<span>`s.
