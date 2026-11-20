---
'@lexical/y': patch
---

[fix] A write that fails and is recovered no longer deletes and retypes a collaborator's character that the update merged into a neighbouring text node: the recovery rewrites the same update, now with its record of merged nodes, so the character keeps its item where it is stored (a composition's hold that ended, showing a collaborator's typed character as a node of its own that Lexical then merged, and a fault in that write, deleted the collaborator's character and wrote it anew as the local client's)

Verify: compose while a collaborator unbolds the text and types in it, insert new nodes from an app's edit in a remote change's read, and make the write of the update that ends the hold fail once; every client and a fresh reader keep the collaborator's character, the same item, once.
