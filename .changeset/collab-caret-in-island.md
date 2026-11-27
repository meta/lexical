---
'lexical': patch
---

[fix] Put the caret back after a collaboration update when it is in a named slot or another editable island

Verify: with the caret in a named slot or a `$markSlotEditable` island in Safari, have a collaborator write earlier in the same text, then type; the character goes where the caret was, where it went to the start of the text before.
