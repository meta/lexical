---
'@lexical/list': patch
---

[fix] A press on a check list item's text that is released over its check mark, such as a text selection dragged onto it, no longer toggles the item

Verify: in a check list, press in an item's text, drag onto its check mark and release; the item keeps its state and the text stays selected. A click on the check mark still toggles it.
