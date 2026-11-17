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

Verify: a node method that depends on the active editor (for example, one that reads an extension's config with `$getEditor()`) used to throw "Unable to find an active editor" in text content listeners, undo merging, markdown shortcuts, collaboration (`@lexical/y`, and `@lexical/yjs` v2; v1 local syncs now read with the editor active too), HMR, `editor.toJSON()`, `exportFile` (and `serializedDocumentFromEditorState`, which takes a new `editor` option), `useLexicalIsTextContentEmpty` and `TableOfContentsPlugin`; it now runs with that editor active. Anything else that depends on the active editor follows it in those reads too: `$getDocument()` returns the editor's own document (an iframe editor's, not the global one), and with structure enforcement on (`NodeStructureExtension` or `@lexical/y`) `$isBlockContainer()` recognizes elements whose children are blocks. New: `editor.read(editorState, fn)` reads a given state of the editor (such as an update listener's `editorState` or `prevEditorState`) with the editor active and without flushing, like `editorState.read(fn, {editor})`.
