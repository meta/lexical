---
'@lexical/y': patch
---

[fix] Store an edit an app makes, in the update of a remote change's read, from a patched `TextNode.prototype.selectionTransform` (which every text class runs), as one from a text class's own `selectionTransform` is: the binding took the patched method for TextNode's own, which does nothing, and wrote nothing, so the edit showed on that client only until the next read

Verify: patch `TextNode.prototype.selectionTransform` to type into the text holding the selection while a collaborator's change is read; every client and a fresh reader show what was typed.
