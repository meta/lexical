---
'@lexical/y': patch
---

[fix] A collaborator's removal of a line that another client composes in no longer comes back: where the removal reached the composing client right after the write ending its composition, and a line followed the removed one, the composing client could read the removed line's text into the line after it and store it again, on every client.

Verify: with two clients, A composes in a code line; B joins that line into the paragraph before it and appends a code block after it (in one update or two), then, offline, removes the joined paragraph, and B's removal reaches A right after A's write ending its composition; every client and a fresh reader end with the code block alone.
