---
'@lexical/list': patch
---

[fix] A touch that starts on a check list item's check mark and moves before lifting, such as a swipe through the list, no longer toggles the item; only a tap does

Verify: on a touch screen, swipe from a check mark and lift the finger away from it; the item keeps its state. A tap on the check mark still toggles it.
