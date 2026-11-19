---
'@lexical/y': patch
---

[fix] Place what a remote change brings by the blocks around it, so that a client read only for an unregistered node type shows blocks in their order and a read never moves a node inside itself

A client read only because the document holds a node type it does not
register showed a paragraph added after such a node at the top of the
editor, and kept showing a line merged away next to one. A remote change
read into an editor that showed an update the binding did not write (one
tagged `SKIP_COLLAB_TAG`) could move a node inside itself, as a child or as
a named slot's value, and the tab hung.

Verify: on a client read only for a node type it does not register, blocks a
collaborator adds next to such a node show where a fresh load shows them. A
read that would place a node inside itself warns with
`RECOVERED_READ_WARNING` and reads the document again instead.
