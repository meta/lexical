---
'@lexical/y': patch
---

[fix] A text node an app or the user inserts with an explicit format while a collaborator's format change to the text being composed is held back keeps that format once the hold ends: it is stored as a run of its own, not inherited from the run the editor goes on showing until then (a new bold node inserted next to text a collaborator just unbolded ended up plain on every client)

Verify: while composing in bold text, have a collaborator unbold it; insert a new bold text node next to it, then end the composition; every client and a fresh reader show the new node bold and the collaborator's text plain.
