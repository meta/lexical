---
'@lexical/y': patch
---

[fix] Keep every unchanged word between two changes of text set with `setTextContent`, so a word a collaborator deletes there at the same time stays deleted

Verify: a line `t1z t2z t3z t4z t5z t6z t7z` set with `setTextContent` to `t1z n9z t3z t4z t5z t6z n8z` while a collaborator deletes `t5z` shows `t1z n9z t3z t4z t6z n8z` on every client (not `t5z` back), and after the collaborator's undo `t5z` once.
