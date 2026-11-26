---
'lexical': patch
---

[fix] Registering a node transform, as `AutoLinkPlugin` does when it re-renders, no longer moves focus into an editor that does not have it

Verify: with a plugin that re-registers its transforms on render (AutoLinkPlugin with an inline matchers array), typing in another input keeps focus in that input; editor.focus() and AutoFocusPlugin still focus the editor. A newly registered transform that itself moves the caret, such as splitting the text node it is in, still focuses the editor, as before.
