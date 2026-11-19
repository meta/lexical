---
'@lexical/selection': patch
---

[fix] `$trimTextContentFromAnchor` trims text an input method commits instead of reverting the node to the text still being composed

Verify: with a maximum length (such as the playground's `MaxLengthPlugin`), commit an input method composition (Japanese, Chinese, Korean, or a dead key) that goes past the limit. The committed text is now cut at the limit. It used to be replaced by what the previous editor state held: the text still being composed, or, for a composition started in an empty paragraph, the placeholder character inserted for it (a non-breaking space in Firefox), so the composed text was lost. Text added outside a composition is reverted as before.
