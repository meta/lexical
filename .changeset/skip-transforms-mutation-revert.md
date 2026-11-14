---
'lexical': patch
---

[fix] The revert of DOM changes the mutation observer recorded, when it joins a pending update made with `skipTransforms`, runs no node transforms either, unless it brings text typed in the DOM into the editor state

The revert joins the pending state whether a commit, the observer's own callback or `setEditorState` starts it. Before, it ran every node transform over what the skipping update had changed, which no later update transformed back. Collaboration bindings apply remote changes with `skipTransforms` (`@lexical/y`, and `@lexical/yjs` v1 and v2), so a remote change read while the DOM held an unprocessed change (a decorator rendering, for one) was transformed in that editor only. A table, for one, was padded with cells no other client had. Every other update that joins such a pending state (one queued after it in the same task, `registerNodeTransform`'s pass over existing nodes, edits a `SELECTION_CHANGE_COMMAND` handler makes as it commits) runs transforms as before.

Verify: an update made with `skipTransforms` while the editor's DOM has an element Lexical did not render (append one to the root just before it) runs no node transforms, and the element is removed; the same update without `skipTransforms`, or after a change to a text node's DOM text, runs them.
