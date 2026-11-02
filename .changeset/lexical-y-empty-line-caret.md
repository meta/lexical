---
'@lexical/y': patch
---

[fix] Keep a caret in an empty line at the line's start when a collaborator types there, instead of inside their word

A caret in an empty line moved after the first character a collaborator
typed there, and their next characters went after it, so the caret's own
next key split their word. It now stays at the line's start, as a caret at
the end of a line with text stays before what a collaborator types after
it. A range that ends or starts in an empty line no longer grows over text typed there.

Verify: a caret in an empty line that a collaborator types or writes into
stays at the line's start (before, it went to the end of a block an agent
wrote there in one change).
