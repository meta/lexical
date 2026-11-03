---
'@lexical/y': patch
---

[fix] A paste over part of a code line (or another line a transform makes again with the pasted text) no longer writes again a character next to the pasted range that equals the last character pasted, which moved a collaborator's concurrent typing there inside the word, or undid their concurrent delete of that character

Verify: in a highlighted code block, paste content with several paragraphs over the end of a comment whose last word before the range ends with the same character as the pasted text, while a collaborator types right after that word: on every client the word stays whole and the typed text follows it.
