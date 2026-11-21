---
'lexical': patch
---

[fix] Write text typed at the edge of a link or a comment outside it when the caret is in an inline element inside it

Verify: in a link that ends with a custom inline element or a `MarkNode`, type at its end; the text lands after the link, where it was lost before (or, after a `MarkNode`, went before the link). At the start of such a link it lands before the link. In a comment's `MarkNode` that ends with a custom inline element, typing at its end writes after the comment, not inside it. Typing at the end of a link that ends a comment now writes after the comment, not before it, and typing between two token text nodes inside a link writes between them, in the link.
