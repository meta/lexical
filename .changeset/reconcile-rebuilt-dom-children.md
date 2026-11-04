---
'lexical': patch
---

[fix] A node removed in the same update in which the reconciler builds its parent's DOM anew no longer stays in the editor's DOM map, and its mutation listeners now receive `destroyed`

When an element's `updateDOM` returns true, the reconciler builds the element and every child under it anew instead of comparing them with their previous children; the same happens to a node moved into a parent's only-child position out of the subtree of the child it replaces. A child (or a slot value) removed from such a node in that update kept its entry in the editor's DOM map (holding a detached DOM element for as long as the editor lived, one more on every such update) and its mutation listeners never received `destroyed`. The reconciler now destroys the previous children and slot values of a node it builds anew that left the editor state. Removed children are destroyed; nodes that stay are not: a child kept under a rebuilt parent gets a new element and reports `created`, as before, and a node or slot value moved elsewhere (including a slot value moved to another host in the same update) keeps its DOM. Slot containers are handled as before.

Verify: in an editor with a DOM and a mutation listener, in one update change a list's type (bullet to number) and remove one of its items; the listener receives `destroyed` for the item and `editor.getElementByKey` returns `null` for it.
