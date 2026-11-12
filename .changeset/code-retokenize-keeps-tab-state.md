---
'@lexical/code-core': patch
---

[fix] A tab or line break inside a code block keeps its NodeState (a comment that spans it, say) when the highlighter tokenizes the block again, as the text around it does

Verify: put text, a tab and a line break that all have a NodeState value inside a code block, then make any edit next to the block; the tab and the line break keep their value.
