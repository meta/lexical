---
'@lexical/y': patch
---

[fix] Place an insertion or a deletion of text set with the caret at the end of the node, past the edit or in a later node at a word edge, as without a caret

Verify: `node.setTextContent('t1z t3z'); node.selectEnd();` on a node holding `t1z t2z t3z`, while a collaborator deletes `t2z`, shows `t1z t3z` on every client (not `t1z 3z`), and a word the collaborator types after `t2z` stays a word of its own.
