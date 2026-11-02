---
'@lexical/y': patch
---

[fix] A write that fails part way is recovered from without repeating what it already stored: the rewrite diffs each line against the document instead of writing the recorded keystrokes again

Verify: when a local write throws after storing part of a change (reported as `@lexical/y/recovered-write`), every client shows the change once, and the author's editor matches its document.
