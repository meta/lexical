---
'@lexical/y': patch
---

[fix] A value a client sets on the text it composes as its composition ends no longer lands on another line: where a collaborator replaced the line being composed in with a new line (a change of its block type) and inserted another line after it in the same update, the composing client's read gave its composed node to the line after the new one, and the value landed there.

Verify: with two clients, A composes in a paragraph followed by another paragraph; B converts A's paragraph to a heading whose text changes in the same update (for example, an app transform that appends `!`) and inserts a paragraph after it, in one update; A's update ending its composition sets a NodeState value on its node; no client shows the value on the paragraphs after the heading. The node being composed is no longer in the document then (the composition ends without it, see y.md's Limits, Input method composition), so the value is not written.
