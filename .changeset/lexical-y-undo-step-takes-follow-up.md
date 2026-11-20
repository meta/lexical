---
'@lexical/y': patch
---

[fix] One redo restores what an undo removed, also when reading the undo made the editor write again (as can happen while the user composes and a collaborator's change to the composed text is held): that write was a step of its own on the redo stack, so one redo redid only it, and the undone change could be lost

Verify: while composing in a text node a collaborator changed (bold removed and a character typed), split the text, type a new character, undo, redo and end the composition; every client shows the character. Undo and redo stacks grow by one step per undo or redo.
