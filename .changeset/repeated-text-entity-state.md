---
'@lexical/text': patch
---

[fix] Use the caret to resolve repeated-character entity insertions without copying NodeState onto newly inserted entities

Verify: Insert a repeated character before existing text matched by a lookbehind-based entity matcher and check that the existing character keeps its NodeState. Type the character at the end instead, or paste a hashtag whose tail repeats the marked text at a comment's edge, and check that the new entity does not inherit that state. Insert a hashtag prefix before existing text by code, with the caret left farther along the node, and check that the existing text keeps its NodeState.
