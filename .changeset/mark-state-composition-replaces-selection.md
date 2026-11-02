---
'@lexical/mark': patch
---

[fix] Text an input method composes over a selection gets the `MarkStateExtension` ids all of the replaced text had, also where the composition writes past the end of a marked run, as text typed over a selection already did

Verify: select the commented end of a word and retype it with an input method (or let one autocorrect it into a longer word): every new letter keeps the comment.
