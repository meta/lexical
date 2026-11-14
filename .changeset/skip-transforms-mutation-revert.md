---
'lexical': patch
---

[fix] The revert of DOM changes the mutation observer recorded but had not reported, which runs as a pending update commits, runs no node transforms when that update was made with `skipTransforms`

Before, that revert joined the pending state and ran every node transform over what the skipping update had changed. With `@lexical/y`, a collaborator's change read while the editor's DOM held an unprocessed change (a decorator rendering, for one) had its tables padded in that editor only, and words typed into the padding cells never reached the other clients. `@lexical/yjs` (collab v1 and v2) applies remote changes with `skipTransforms` too, so their commits get the same change. Every other update that joins such a pending state (one queued after it in the same task, `registerNodeTransform`'s pass over existing nodes, edits a `SELECTION_CHANGE_COMMAND` handler makes as it commits) runs transforms as before.

Verify: an update made with `skipTransforms` while the editor's DOM has a change Lexical has not processed (append an element to the root just before it) runs no node transforms, and the change is reverted; the same update without `skipTransforms`, and an update queued after it in the same task, run them.
