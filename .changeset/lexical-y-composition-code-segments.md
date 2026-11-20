---
'@lexical/y': patch
---

[fix] Keep the text before the node being composed with an IME in a code line whose token is split into several highlight nodes (for example by comment ids) when a collaborator's change to that line arrives during the composition

Verify: in a code block line whose comment token carries a comment on part of it, compose with an IME after the commented part while a collaborator comments or uncomments text in that line: when the composition ends, every client shows the whole line.
