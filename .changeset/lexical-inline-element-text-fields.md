---
'lexical': patch
'@lexical/clipboard': patch
---

[fix] Stop serializing the textFormat and textStyle of an inline element whose text sits in another element inside it

An element persists its textFormat and textStyle only when it has no text to derive them from (#7968), and a reconcile derives them from its first text at any depth. The JSON of an inline element (a link, an autolink, a mark) now follows the same rule: a link whose text sits in a mark no longer writes them, as a link with text of its own already did not. JSON that holds them still reads the same, and a block keeps the direct-children check, so the JSON of a paragraph whose text is all inside links, and of every other node, is unchanged.

Verify: JSON snapshots of an inline element (a `link`, `autolink` or `mark`, or your own inline `ElementNode`) whose children are all elements no longer hold `textFormat` or `textStyle`.
