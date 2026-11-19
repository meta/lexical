---
'@lexical/y': patch
---

[fix] Text typed into a code highlight token that a stored format bit covers in part (a bold or italic the highlight ignores) reads as the one node its author shows, so the author's editor matches its document

A code highlight node keeps no format bits, but a bit can still be stored over part of one: written while the token was plain text, or by a write from outside the editor. Readers cut the token in two where the stored bits changed, while text typed into it stores the formats the node shows (none), so a fresh read of the document split off the typed text and differed from the author's editor. Readers now read text whose stored formats differ as one node when the nodes built from it show the same formats (a code highlight shows none); the bits stay stored, and text whose class shows them reads as before.

Verify: store a bold over the second word of a code highlight `alpha beta` from outside the editor, type at the end of the token or at the start of `beta`, and check that the author's editor equals a fresh read of its document and that `beta` is still stored bold.
