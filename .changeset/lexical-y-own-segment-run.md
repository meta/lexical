---
'@lexical/y': patch
---

[fix] Keep a tab a tab when it was written right next to a tab a collaborator added with one Tab press and then undid, and keep token or segmented text written right before a collaborator's node of the same kind in its mode when they undo theirs

Verify: in a shared document, one person presses Tab right next to a tab another person added with one Tab press; when the other person undoes, the first person's tab is still a tab for everyone (not a tab character in the text before it). A link or format a collaborator removes around a tab at the same time stays removed. A stored line where two people's tabs were shown as one tab now shows both tabs.
