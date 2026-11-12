---
'@lexical/code-core': patch
'@lexical/code-prism': patch
'@lexical/code-shiki': patch
---

[fix] The code highlighter writes a token an app's tokenizer makes in place of an old token with the same text and highlight type when it adds to it (the app's own CodeHighlightNode subclass, or a NodeState value the tokenizer sets) and loses nothing of it, one for one, so the tokenizer's class, fields and NodeState are kept beside text with NodeState (a comment, say), where the highlighter kept the old token

Verify: with a tokenizer that returns its own CodeHighlightNode subclass, put code highlight tokens as the stock tokenizer makes them, each with a NodeState value, inside a code block, then make any edit next to the block; each token is of the tokenizer's class, and keeps the value of its own text.
