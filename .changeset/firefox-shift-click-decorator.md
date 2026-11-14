---
'lexical': patch
---

[fix] Shift-click on an inline decorator preserves selection and places focus beside the decorator

A Shift press on a decorator, other than on an embedded `<input>`, `<textarea>` or contenteditable, is now followed like a mouse drag: the anchor stays and the focus goes beside an inline decorator, on the side of the half that was clicked. In Chromium a Shift+click on the right half of an inline decorator now selects through it.

Verify: in Firefox, put the caret in text before an inline decorator, Shift+click the decorator and type a character; the character replaces the selection that ends beside the decorator.
