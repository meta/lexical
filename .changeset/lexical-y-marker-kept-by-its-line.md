---
'@lexical/y': patch
---

[fix] Keep a line's marker with the line that continues it: where a collaborator replaced a line (a change of its block type, or a new block holding its text) and added a block after it in one update, the new block took the old line's marker, so a client composing in that line saw its composition move to the new block, and ending it re-tokenized that block with its code highlighter (dropping its format and NodeState) or wrote what it typed there

Verify: with two clients, A composes at the end of a paragraph while B replaces that paragraph with a quote holding its text and adds a code block with underlined text after it; when A's composition ends, the code block keeps its underline and NodeState on every client, and the text A composed stays in the quote. Enter, Backspace across lines and a range delete across lines store the same as before.
