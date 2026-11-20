---
'@lexical/y': patch
---

[fix] Place an insertion or a deletion found in text set without a caret at a word edge, so a collaborator's concurrent edit of the same word does not take a letter of the next one

Verify: `setTextContent` (or a node's text set whole) that deletes or inserts whole words, with no caret in the node, while a collaborator deletes or edits the same words: `t1z t2z t3z` set to `t1z t3z` while a collaborator deletes `t2z` shows `t1z t3z` on every client, not `t1z 3z`.
