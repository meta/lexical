---
'@lexical/list': patch
---

[fix] Stop writing `value` on every list item, which made Enter near the top of a long list quadratic in Chromium

Verify: numbered lists show the same numbers as before (including lists with a `start`, nested lists and the item after them), bullet and check items carry no `value` attribute, and copied or exported HTML still writes `value` on every item.
