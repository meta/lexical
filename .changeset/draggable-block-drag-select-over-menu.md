---
'@lexical/react': patch
---

[fix] Drag-selecting text over the `DraggableBlockPlugin_EXPERIMENTAL` menu keeps the selection under the pointer instead of extending it to the start of the document

Verify: with the DraggableBlockPlugin_EXPERIMENTAL menu showing, drag-select text and move the pointer over the + button or the drag handle; the selection should end at the text beside the pointer, and the menu should respond to clicks and drags after the button is released.
