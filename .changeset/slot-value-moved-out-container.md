---
'lexical': patch
---

[fix] A named slot's value moved out of its slot no longer makes the reconciler remove the DOM of the element it moved into

When a slot's value moved, in one update, into an element rendered before its old host (as a child or into a slot of that element, which can be new, existing, or built anew because its `updateDOM` returns true) while its slot was removed, given another value, or its host was removed, the reconciler had already moved the value's DOM when it cleaned up the old slot, and it removed the value's new parent instead of the old slot container. The element it moved into lost its DOM (the editor state was right, the DOM no longer matched it), and when that element's `updateDOM` returns true, the next update that inserted a node next to it threw `NotFoundError`. Swapping two slot values in one update could also leave one value's DOM outside the editor. The reconciler now keeps the old slot container of a slot value whose DOM it moves and removes that container. Named slots are experimental.

Verify: in a mounted editor, with an element `R` before an element `A` whose slot `s0` holds `B`, in one update remove the slot and append `B` to `R`; `R`'s DOM stays in the editor and the editor's DOM matches a fresh render.
