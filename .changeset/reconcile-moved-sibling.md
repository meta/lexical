---
'lexical': patch
---

[fix] The reconciler no longer throws `DOMSlot.insertChild: before is not in element` when an update creates an element whose children include a node moved out of the same parent, right where that node was

The reconciler reuses the DOM of a node moved to another parent. A new element is built with its children before it is inserted, so when one of those children was the sibling it was to be inserted before, that sibling was already inside the new element. The reconciler now inserts it where the sibling stood. Lexical reported the error and re-rendered the editor. Collaboration reads such updates (a collaborator joining a nested list item into the previous one keeps the keys of the moved text and links), and there the re-render could fail as well, after which the editor no longer followed its document.

Verify: in an editor with a DOM, in one update move the inline nodes of a paragraph so that a new link takes in the node it was created in front of (for example `x`, a line break, `y`, a link, `w` becomes `x`, the link, a new link holding `w`, the line break), and check that nothing throws and the DOM matches a fresh render.
