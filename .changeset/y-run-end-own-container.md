---
'@lexical/y': patch
---

[fix] A format write never links an item into another container: an editor no longer stops matching its own document after a style change next to a collaborator's run in a table cell

Verify: in a document with a table, one client colors the end of a cell's text, clears the color of one character there, then colors a word in the paragraph before the table; after syncing, the other client recolors part of that cell. Both editors keep matching their documents through later edits and syncs, and no `@lexical/y/recovered-write` warning is reported.
