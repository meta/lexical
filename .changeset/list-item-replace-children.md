---
'@lexical/list': patch
---

[fix] Preserve children when replacing a list item with another list item using `replace(otherItem, true)`

Verify: call `item.replace(otherItem, true)` on a list item containing text or a nested list. Its children are appended to the replacement instead of being discarded. With the caret inside the item's text, the update no longer throws `selection has been lost` and the caret stays where it was.
