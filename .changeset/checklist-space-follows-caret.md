---
'@lexical/list': patch
---

[fix] After a click on a check mark, a Space typed while the caret is in another block goes to the caret instead of toggling the item back

Verify: put the caret in a paragraph, click a check list item's check mark, then type a space; the item stays checked and the space is typed at the caret. With the caret in the item, as when it is reached with the arrow keys, Space still toggles it.
