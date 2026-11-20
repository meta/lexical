---
'@lexical/list': patch
---

[fix] Stop writing `value` on every list item, which made Enter near the top of a long list quadratic in Chromium

Verify: numbered lists show the same numbers as before (including lists with a `start`, nested lists and the item after them), bullet and check items carry no `value` attribute, and copied or exported HTML still writes `value` on every item, in the same place as before.

Live list items in the editor no longer carry `value` where the browser's own count shows their number: reading `li.value` from the editor's DOM gives `0` for them, and `li[value]` or `attr(value)` CSS no longer matches. Read the number with `ListItemNode.getValue()`, or from `exportDOM`. Because the browser counts the items it draws, an item hidden with `display: none` (or a list drawn `reversed`) shifts the numbers after it.
