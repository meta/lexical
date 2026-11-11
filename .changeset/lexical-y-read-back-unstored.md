---
'@lexical/y': patch
---

[fix] Read back what a local update leaves that the document does not store: an emptied token, segmented, code highlight or subclass text node, and a slot set while read only on a node that cannot hold stored slots, stayed on the editing client only, with no warning

Verify: empty a token text node with `setTextContent('')` with the selection elsewhere; the editor removes the node after the write, reports `UNSUPPORTED_EDIT_WARNING` with the new `data.reason` `'unstorable'` (`editYState` returns it too), and every client and a fresh reader agree. Code that handles every `YUnsupportedEditData` reason handles the new one.
