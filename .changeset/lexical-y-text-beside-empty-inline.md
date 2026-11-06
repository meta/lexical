---
'@lexical/y': patch
---

[fix] Store text written beside an inline element the editor does not show (a comment whose text peers deleted concurrently, or whose text has not arrived yet) where the editor shows it: text set on a node next to it landed on the element's other side
