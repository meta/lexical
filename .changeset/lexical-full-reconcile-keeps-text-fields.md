---
'lexical': patch
---

[fix] A full reconcile no longer changes the textFormat or textStyle of an element the update did not change, so re-rendering every node (such as `MarkStateExtension` applying a new `isMarkIDShown`) no longer makes an edit: no history entry, nothing written to collaborators

Verify: in a document whose paragraph's stored textFormat differs from its first text's format (as a headless client writes it), assign a new `isMarkIDShown` and check that the next undo takes back the last edit, not an invisible format change.
