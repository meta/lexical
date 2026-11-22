---
'lexical': patch
---

[fix] When the shadow root transform wraps the inline children of a shadow root in a paragraph, a caret in the first of them stays where it was, and an element point on the shadow root keeps its place among the regrouped children

Verify: make a quote of text a shadow root (`setIsShadowRoot(true)`) with the caret at the end of its text, as an app that turns every pasted `<blockquote>` into a shadow root does; after the update the caret is still at the end of the text, now in a paragraph. A selection at an element offset on the quote between two of its inline children ends at the same gap inside the new paragraph.
