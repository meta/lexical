---
'lexical': patch
---

[fix] Allow deleting characters beside inline links inside named slots

Verify: Place the caret immediately before or after a link inside a named slot and press Delete or Backspace. The adjacent character should be removed while deletion at the slot's outer boundary stays contained.
