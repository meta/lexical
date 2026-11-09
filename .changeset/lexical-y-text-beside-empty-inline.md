---
'@lexical/y': patch
---

[fix] Store text written beside an inline element the editor does not show (a comment whose text peers deleted concurrently, or whose text has not arrived yet) where the editor shows it: text set on a node next to it landed on the element's other side, and text typed or deleted next to it could be stored one position off

Verify: with a comment whose text two collaborators delete at the same time (each half), or whose text has not arrived yet, set the text of the text node right after it (as a composition does), type into it or delete from it, and change its format; every client and a fresh reader show the text and the format where the editing client shows them.
