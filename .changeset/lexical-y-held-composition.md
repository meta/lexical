---
'@lexical/y': patch
---

[fix] Refuse a local change that would delete text a collaborator wrote in the line being composed, where the change inserts no character

While a composition (IME) holds back a collaborator's change to the line being composed, a local change that moves, replaces or removes what holds that text (moving the list item composed in, unwrapping an inline element around it, moving or replacing a slot's paragraph) and inserts no character (it only moves, deletes or re-keys text) is no longer written: the editor reads the document again, so the change is undone and the collaborator's text stays, and `UNSUPPORTED_EDIT_WARNING` reports it with the new reason `'held-composition'`. The binding stays active. A change that inserts a character (typing, a composition's text, paste) is written as made, so that no typed character is undone; where it also moves or removes the element composed in, the collaborator's held text goes with it, as before.

Verify: compose with an IME in an inline element inside a list item while a collaborator types into the same line, then move the list item (or unwrap the element) before the composition ends: the move is undone, the collaborator's text is kept on every client, and `UNSUPPORTED_EDIT_WARNING` with `reason: 'held-composition'` is reported once. Typing in the same update as the move is written, every typed character kept.
