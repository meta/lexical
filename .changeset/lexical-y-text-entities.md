---
'lexical': patch
'@lexical/text': patch
'@lexical/y': patch
---

[fix] Keep a collaborator's concurrent edits in hashtags and other text entities that grow over the next word or are made again, in `@lexical/y`

`registerLexicalTextEntity` now tells `@lexical/y` which characters a grown entity took from the next text node and which node holds a remade entity's text, so those characters keep their identity in the shared document. Without `@lexical/y` it makes the same calls as before and records nothing.
