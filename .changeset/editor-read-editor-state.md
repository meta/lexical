---
'lexical': patch
---

[feature] `editor.read(editorState, fn)` reads a given state of the editor, such as an update listener's `editorState` or `prevEditorState`, with the editor active and without flushing, like `editorState.read(fn, {editor})`

The overload changes no existing call: its first parameter is an `EditorState`, which no earlier call passes. Only an object typed as `Pick<LexicalEditor, 'read'>` (`LexicalEditor` is exported as a type, not a class to extend) has to accept the new shape.

Verify: `editor.read()` with an object that is not an `EditorState` from this copy of Lexical (such as a state from a duplicated copy of `lexical`) as its first argument now throws; it used to read the committed state, the wrong document. Any other value that is not a read mode (such as `undefined` forwarded from an optional mode) still reads the committed state, and logs a development warning once.
