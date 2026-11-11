---
'@lexical/y': patch
---

[fix] Keep `$initialEditorState` out of a document that already has content when the editor is bound with `YCollabExtension`

The binding now starts once the editor has its initial state. On a document
that already has content (the editor built again on the same document, a
document loaded from a cache before the editor, `synced: true`), the editor
shows the document and writes nothing, where a template used to replace the
shared content or add a copy on every mount. The initial state is only
written into an empty document, by `initialize()`: clients that initialize a
new document with the same content at once write it once (when they write
the same items, as before), now also with `synced: true`, which wrote the
template as an edit after an empty seed. The same holds for content other
extensions write while they register, and for a state `HMRExtension`
restores.

Verify: another extension's `register` sees the binding before it starts
(`status` is `'pending'` and `undoManager` is `null` until
`afterRegistration`), and on dispose the binding stops before the other
extensions' `register` cleanups run. `YBinding.initialize()` called before
`start()` runs when the binding starts, instead of writing at once. An editor
opened on an initialized document whose root is empty shows it empty instead
of writing an empty paragraph.
