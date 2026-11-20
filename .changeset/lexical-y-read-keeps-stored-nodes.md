---
'@lexical/y': patch
---

[fix] A remote change read next to content that an update tagged `SKIP_COLLAB_TAG` rearranged (a box moved into a box it held, or out of the one that stores it) no longer drops that content from the editor: the whole document is read again instead, with a warning

Verify: with the self-check on, move a container into one it held in an update tagged `SKIP_COLLAB_TAG`, have a collaborator insert a block next to it, and check that the editor still shows every block.
