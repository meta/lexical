---
'@lexical/list': patch
---

[fix] A list item outside a check list loses a `checked` value once an update edits it, as `ListItemNode`'s transform always meant: it tested `getChecked()`, which is undefined there, so a value an update without transforms left (a collaborator's change read in `@lexical/y`) stayed hidden and showed again once the list became a check list

Verify: in `@lexical/y`, check an item in a check list and join it with the next while a collaborator turns the list into a numbered list and back into a check list; every client shows the item the same way, and no self-check warning is reported. A check list turned into another list type and back shows its items unchecked, as before.
