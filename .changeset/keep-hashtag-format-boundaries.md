---
'@lexical/text': patch
---

[fix] Keep format, style and detail boundaries when growing hashtags and other normal-mode text entities

Text after an entity keeps its own formatting. Formatting part of an existing hashtag splits it at the format boundary, and text typed with another format at the end stays outside the hashtag.

Verify: Type ` #tag ` inside plain text next to a bold word and check the formatting and caret position. Type with bold enabled at the end of a hashtag, and bold either the start or the end of an existing hashtag.
