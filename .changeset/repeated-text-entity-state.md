---
'@lexical/text': patch
---

[fix] Use the caret to distinguish newly inserted entities from existing text when repeated characters make the edit ambiguous

Verify: Insert a repeated character before existing text matched by a lookbehind-based entity matcher and check that the existing character keeps its NodeState. Type the character at the end instead, or paste a hashtag whose tail repeats the marked text at a comment's edge, and check that the new entity does not inherit that state. Insert a hashtag prefix before existing text by code, with the caret left farther along the node, and check that the existing text keeps its NodeState. When the caret is outside the edited node, change `tag` to `tag #tag` by code and check that the repeated-tail entity keeps the original NodeState under the conservative alignment fallback.
