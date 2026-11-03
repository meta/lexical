---
'lexical': patch
---

[fix] Keep the caret out of a scroll container's `scroll-padding` when the caret is scrolled into view, as already done for the document's, so it no longer stops under a sticky toolbar inside that container

Verify: in an editor inside a scrolling element with `scroll-padding-top`, move the caret above the visible area (ArrowUp, or Enter at the bottom with `scroll-padding-bottom`); it lands inside the padding's edge.
