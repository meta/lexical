---
'lexical': patch
---

[feature] `editor.read(editorState, fn)` reads a given state of the editor, such as an update listener's `editorState` or `prevEditorState`, with the editor active and without flushing, like `editorState.read(fn, {editor})`

The overload changes no existing call: its first parameter is an `EditorState`, which no earlier call passes. Only an object typed as `Pick<LexicalEditor, 'read'>` (`LexicalEditor` is exported as a type, not a class to extend) has to accept the new shape.

Verify: `editor.read()` with a first argument that is neither an `EditorState` from this copy of Lexical nor a read mode (for example a state from a duplicated copy of `lexical`, or `undefined` forwarded from an optional mode) now throws. It used to read the committed state without flushing, which for a state returned the wrong data.
