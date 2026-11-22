---
'@lexical/a11y': patch
---

[fix] `RovingTabIndexExtension` no longer takes arrow, Home and End keys from a focused element inside the group that is not one of its items (such as a font size input in a toolbar); it moved focus to the first item. Focus on the container itself still enters the group at the first item
