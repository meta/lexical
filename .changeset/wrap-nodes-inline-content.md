---
'@lexical/selection': patch
---

[fix] `$wrapNodes` keeps a paragraph's nested inline elements (a link inside a comment mark, overlapping marks) and the character limit's `OverflowNode` in the wrapped block, and no longer hangs on a range that starts inside one

Verify: `$wrapNodes` on a selection inside an inline element nested in another inline element, or inside an `OverflowNode`, now wraps the whole paragraph with all of its inline content, as it already did for text directly in the paragraph or in one inline element. Before, the paragraph was split around the inner element and the outer one (the mark, the overflow) was dropped, and a range starting there and ending later in the paragraph or in the next one never returned.
