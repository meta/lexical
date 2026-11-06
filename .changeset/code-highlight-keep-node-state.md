---
'@lexical/code-prism': patch
'@lexical/code-shiki': patch
---

[fix] Code highlight nodes that turn back into text when they leave a code block keep their NodeState, such as `MarkStateExtension` comment ids

Verify: turn a code block whose text carries NodeState (comments) into a paragraph and check that the text keeps it.
