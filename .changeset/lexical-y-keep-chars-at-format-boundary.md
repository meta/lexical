---
'@lexical/y': patch
---

[fix] Keep the characters a block rewrite leaves unchanged next to a word that was a node of its own in `@lexical/y`, so a collaborator's concurrent edit of that word no longer lands inside the word before it

Verify: rewrite a line's children as one plain node with one formatted word changed while a collaborator edits that word; the words around it stay whole on every client.
