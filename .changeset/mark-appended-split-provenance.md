---
'lexical': patch
'@lexical/mark': patch
---

[fix] Keep ordinary text split from an appended multi-hashtag paste outside the preceding comment

MarkStateExtension requests split and same-text replacement provenance without enabling the full text-edit log. This also applies when composed text becomes entities after an IME composition ends. Explicitly copied marks and marked text moved from another block retain their own ids.

Verify: paste ` #first #see` at the end of a comment on `see` and check that neither hashtag nor the space between them joins the comment. Copy marked plain text into a new node and move a marked split piece from another block, and check that their marks remain.
