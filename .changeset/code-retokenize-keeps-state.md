---
'@lexical/code-core': patch
'@lexical/code-prism': patch
'@lexical/code-shiki': patch
---

[fix] The code highlighter keeps the NodeState of text inside a code block (comment ids, a suggestion's members) when it tokenizes the block again: a token is split at the boundaries of each node with NodeState, and each part keeps the state of the text it came from, as a copy of the token (text with NodeState that entered the block, by a merge or a collaborator's change, lost it on the next highlight pass). An untouched token of an app's own highlight class keeps its class and fields, and a NodeState value the tokenizer sets on a token stays the tokenizer's

Verify: put a text node with a NodeState value inside a code block (or merge a quote whose text has one into it), then make any edit next to the block; the text keeps its value, in its own highlight token.
