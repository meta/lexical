---
'lexical': patch
---

[feature] `editorState.toJSON({compact, editor})` exports a state with its editor active, so a node whose `exportJSON` calls `$getEditor()` can, without wrapping the call in a read; `compact` picks the form as the boolean argument does, and the return type follows it

The new overloads come before the boolean ones, so `Parameters<EditorState['toJSON']>` and other type helpers still resolve to the boolean signature. Only code that re-declares `toJSON`, such as an object typed as `Pick<EditorState, 'toJSON'>`, has to accept the new shape.
