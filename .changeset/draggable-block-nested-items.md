---
'@lexical/react': patch
---

[feature] `DraggableBlockPlugin_EXPERIMENTAL` drags list items on their own: the handle targets the block under the pointer at any depth (a list item in a nested list, not the whole list), an item can be dropped into any list or outside a list (where it gets a new list of the same type), and a block that is not a list item dragged over a list lands next to that list, so the drop line only shows where the drop will happen. The drop line is indented to the target's left edge. Descent stops at shadow roots (tables, layout containers, collapsibles), which are still dragged as one block.

Verify: in the playground, hover a list item (the handle appears for the item), drag it below another item of the same, a nested or another list, drag it below a paragraph, and drag a paragraph onto a list item.
