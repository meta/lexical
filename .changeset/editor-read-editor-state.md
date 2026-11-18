---
'lexical': patch
---

[feature] `editor.read(editorState, fn)` reads a given state of the editor, such as an update listener's `editorState` or `prevEditorState`, with the editor active and without flushing, like `editorState.read(fn, {editor})`

The overload changes no existing call: its first parameter is an `EditorState`, which no earlier call passes. Only code that re-declares `read`, such as a subclass that overrides `LexicalEditor.read` or an object typed as `Pick<LexicalEditor, 'read'>`, has to accept the new shape.

Verify: in development, `editor.read()` with a first argument that is neither an `EditorState` from this copy of Lexical nor a read mode (for example a state from a duplicated copy of `lexical`) now logs a warning once; as before, it reads the committed state without flushing.
