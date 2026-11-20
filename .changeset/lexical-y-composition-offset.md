---
'@lexical/y': patch
---

[fix] A composition that receives a collaborator's text typed at the same place at the same time goes on after the composer's own text, instead of landing inside the collaborator's word

Verify: compose (IME) at the end of text you just typed while a collaborator types a word at the same place, in a change that also deletes other text of the line: the next composed characters follow your text and the collaborator's word stays whole.
