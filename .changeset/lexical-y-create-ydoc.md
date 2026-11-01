---
'@lexical/y': patch
---

[fix] Bind only documents from `createYDoc`, now also exported by `@lexical/y`, so that a document that applies a stored state before the binding attaches no longer deletes formats the binding keeps

`YCollabExtension`'s `doc` and `YBinding` take a `YDoc`, the type
`createYDoc(state?, options?)` returns: a `Y.Doc` with Yjs's format cleanup
off before anything is applied to it. In a plain `new Y.Doc()` that applied
a stored state before the editor was bound, the cleanup deleted the format
items left where text was deleted. Text a collaborator typed there at the
same time (an agent's edit inside a commented word) then showed without its
formats on that client and with them on every other, and the deletion
reached every client. The binding now opens a document with the cleanup on
read only, with an `UNSUPPORTED_CONFIG_WARNING` (`reason:
'cleanup-formatting'`).

Verify: every document you bind comes from `createYDoc` (`createYDoc(stored)`
where you load a stored state), and the provider gets that same document.
Code that reads `UNSUPPORTED_CONFIG_WARNING`'s `data.options` checks
`data.reason === 'repair-transforms'` first.
