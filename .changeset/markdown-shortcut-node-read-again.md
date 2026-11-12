---
'@lexical/markdown': patch
---

[fix] The markdown shortcuts look the text node up again by its key when their update runs, and skip the shortcut when the editor no longer has that node (the editor read the document again first, as a collaboration binding does when it rebuilds the editor state), where they reported "Lexical node does not exist in active editor state"

Verify: with the markdown shortcuts registered, set a new editor state parsed from the current one in an update listener that runs ahead of theirs, right after a keystroke that completes a shortcut (`# `, say); no error is reported, that keystroke's shortcut is skipped, and typing it again in the node the editor read again transforms as before.
