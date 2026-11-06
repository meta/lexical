---
'@lexical/y': patch
---

[fix] An edit made while a remote change is still unread (an app's mutation listener's, with a provider applying the change inside a local update) is stored where the editor shows it when the local and remote changes deleted overlapping text: it could be stored past the end of the line, as a paragraph the editor did not show. `$resolveCursor` also resolves a position past such text where the editor shows it (it could be one character early).

Verify: give an editor with a DOM root a `TextNode` mutation listener that appends to the last line; offline, delete part of that line on a peer, and delete an overlapping range locally in an update that applies the peer's change (origin `'provider'`); after syncing, the editor, a fresh read of its document and the peer show the same text, with no extra paragraph.
