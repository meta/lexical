---
'lexical': patch
'@lexical/extension': patch
'@lexical/file': patch
'@lexical/history': patch
'@lexical/markdown': patch
'@lexical/mdast': patch
'@lexical/react': patch
'@lexical/rich-text': patch
'@lexical/y': patch
'@lexical/yjs': patch
---

[fix] Keep the editor active wherever Lexical reads an editor state from a listener, so a node's `getTextContent()`, `exportJSON()` and other methods can call `$getEditor()` there

Verify: a node method that depends on the active editor (for example, one that reads an extension's config with `$getEditor()`) used to throw "Unable to find an active editor" in text content listeners, undo merging, markdown shortcuts, collaboration (`@lexical/y`, and `@lexical/yjs` v2; v1 local syncs now read with the editor active too), HMR, `editor.toJSON()`, `exportFile` (and `serializedDocumentFromEditorState`, which takes a new `editor` option), `useLexicalIsTextContentEmpty` and `TableOfContentsPlugin`; it now runs with that editor active. Anything else that depends on the active editor follows it in those reads too: `$getDocument()` returns the editor's own document (an iframe editor's, not the global one), and with structure enforcement on (`NodeStructureExtension` or `@lexical/y`) `$isBlockContainer()` recognizes elements whose children are blocks. A command dispatched from inside one of these reads now gets the existing development warning about updates started in a read-only context, as inside `editor.read()`; dispatch after the read returns. `@lexical/yjs` local syncs apply their awareness update after the read, so awareness listeners run outside it. Yjs's callbacks during a `@lexical/y` local write (observers, `afterTransaction` handlers, its undo manager's listeners) still run as before: without an active editor, or in the context of an app transaction the write joins.
