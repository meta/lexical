---
'@lexical/y': patch
---

[fix] Store text written beside an inline element the editor does not show (a comment whose text peers deleted concurrently, or whose text has not arrived yet) where the editor shows it: text set on a node next to it landed on the element's other side

Verify: with a comment whose text two collaborators delete at the same time (each half), or whose text has not arrived yet, set the text of the text node right after it (as a composition does) or type into it, and change its format; every client and a fresh reader show the text and the format where the editing client shows them.
