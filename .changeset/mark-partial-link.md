---
'@lexical/mark': patch
---

[fix] `$wrapSelectionInMarkNode` marks only the selected part of a link when the selection starts before the link and ends inside it, instead of the whole link
