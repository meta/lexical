---
sidebar_position: 3
---

# Block IDs

[`BlockIdExtension`](/docs/extensions/block-ids) stores each block's id as
NodeState, so ids sync through any collaboration binding that synchronizes
NodeState.

- **Assignment.** The collaborator who creates a block assigns its id. A
  pasted or duplicated block is repaired in the update that creates it, so it
  reaches the others with its own id. Two clients that put the same initial
  content into empty editors give it the same ids.
- **Duplicates.** Duplicates that appear only when concurrent edits merge
  are repaired the same way on every replica: the earliest holder in
  document order keeps the id, and the others get ids
  [derived from it](/docs/extensions/block-ids#id-format). Every replica
  reaches the same result without coordination.

**Enable the extension on every client that writes.** A client without it
writes blocks without ids, which every collaborator then names by place
([positional ids](/docs/extensions/block-ids#documents-stored-without-ids)).
Positional ids come from the document a collaborator sees, so when such a
client writes between two collaborators' repairs (while one of them has
unsynced edits, or when they open the document at different moments), they
derive different ids for the same block. The shared document keeps one of
them, and on the other collaborator an id it already wrote changes once.
The collaborators converge, the ids stay unique, and nothing changes after
that, but an id read in between can stop naming its block.

With [`@lexical/y`](/docs/collaboration/y), the binding names the blocks
a remote change brings without a unique id as it reads them, and writes
nothing: a block that stores no id (written by a client without the
extension), or that stores an id an earlier block also stores (a list whose
items all store its id, split by concurrent edits) or shows (a copy of the
JSON of a block as a reader showed it), shows an id derived from its own Yjs
identity (`y`, a client, `_`, a clock, in base 36, with a suffix for a list
and for a list item that holds a nested list, at each level, and for a line
left without a marker that starts with a block stored in it), followed by
`_d` where an earlier block stores that one too, the same on every client
with the extension and every reader. So does the paragraph a reader shows
around text that lands directly in a quote that holds paragraphs (typed into
a paragraph a collaborator moved into the quote): its id comes from that
text's first character, as a line's without a marker does. The next local edit of that block
stores the id it shows. Blocks inside named slots that repeat an id (a
decorator copied with its slots) are the exception: `BlockIdExtension`
renames them after the read, as with other bindings, and every client
writes those names. `YCollabExtension` also sets `BlockIdExtension`'s
`repairTransforms` to `false`: a naming update that runs the editor's
transforms would change what a remote change brought.

Mixed configurations, where some clients that write have no
`BlockIdExtension` (or another `$isIdentifiedBlock`), are supported but
discouraged. Every client shows what a client of its own configuration that
opens the document then shows, and the document stays the same for all, but
the ids differ between configurations:

- A client without the extension shows only the ids that are stored: no id
  on a block written without one, where clients with the extension show its
  derived id.
- It keeps the ids it shows: a block it pastes or duplicates stores the id
  of the block it was copied from, so two blocks store one id. It shows that
  id twice; clients with the extension show it on the first block in
  document order and a derived id on the other.
- An id it stores on a list that is not an identified block (a list moved
  or pasted into a table cell) is shown only by clients without the
  extension; clients with it show no id there. Any other block that is not
  an identified block where it sits (a box or a table pasted into a table
  cell) keeps its stored id on every client, so a copy pasted there shows
  the original's id on both blocks, whatever the configuration.

An id a client sets on a block is stored, whatever its configuration, and
the first local edit of a block on a client with the extension stores the id
that client shows.
