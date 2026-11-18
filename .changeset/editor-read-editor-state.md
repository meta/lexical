---
'lexical': patch
---

[feature] `editor.read(editorState, fn)` reads a given state of the editor, such as an update listener's `editorState` or `prevEditorState`, with the editor active and without flushing, like `editorState.read(fn, {editor})`
