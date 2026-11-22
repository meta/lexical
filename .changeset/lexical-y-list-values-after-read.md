---
'@lexical/y': patch
---

[fix] Number the list items of a freshly bound editor right away when the document holds a block with a named slot

A list item's `value` is derived from its list's `start` and is not stored:
the binding numbers the items in an update right after each read. In an
editor that uses named slots, Lexical re-renders in an update of its own
whenever the editor's editable state changes, which the binding does after
a read (it becomes editable once the first read is done, and read only once
a remote change brings node types it lacks). With that update still
pending, the numbering waited for the editor to be idle, a microtask later,
and until then the editor numbered every list item 1 (`getValue()` and
`<li value>`) and ignored a custom `start`. The numbering now commits that
update first and runs as soon as the read is done.

Verify: right after `binding.initialize()` returns (or after a remote change
is applied), with nothing awaited, the list items of an editor bound to a
document that holds a slot block read the values a fresh `readYState` of
the same document reads.
