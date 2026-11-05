---
'@lexical/y': patch
---

[fix] Keep a collaborator's text that waits behind an IME composition, or a change applied during an update, when the update moves the line holding it: moving the list item being composed (in its list, to another list, nested) no longer deletes text a collaborator typed into it, inside an inline element, on every client, nor leaves it glued to the next line

Verify: while composing in a list item, apply a collaborator's insert into it and move the item; after the composition ends, every client and a fresh reader show the insert in the moved item. A move of the line being composed, while such a change waits, to another container (into or out of a table cell or a block container, an inline element to another line) is not stored: the editor shows the document again and reports `UNSUPPORTED_EDIT_WARNING` with the new `data.reason` `'composing-move'`.
