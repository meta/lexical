---
'@lexical/yjs': patch
---

[fix] Collaboration v2: a block or text that equals another (table rows or list items with the same content, a text node made again with the same text) no longer leaves an editor showing content in the wrong place, or failing with "Lexical node does not exist", after a collaborator's later edit

Verify: with the v2 binding, two or three collaborators insert table rows and columns at the same time in a table whose rows are empty or equal, or edit list items with equal text; once every change is delivered, each editor shows the same document as a fresh reader of it, with no row left without cells.
