---
'@lexical/y': patch
---

[fix] An edit an app's mutation listener makes is stored once, as the editor shows it

A mutation listener that edits the document (in an editor with a DOM root) runs while Lexical still notifies the listeners of the commit that triggered it, and Lexical runs the update it makes at once. Once the editor had committed in a task, the binding made that update commit synchronously, inside that notification: its listeners ran before the rest of the outer commit's, which then wrote an older state over it, so the document stored the edit more times than the editor showed it. The binding no longer forces that commit while Lexical notifies a commit's listeners.

Verify: in an editor with a DOM root, register a TextNode mutation listener that appends a character to the last line a few times; after remote changes, the editor, a fresh reader of the document and every peer show the same number of characters.
