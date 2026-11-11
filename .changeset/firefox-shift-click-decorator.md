---
'lexical': patch
---

[fix] Shift-click on an inline decorator preserves selection and places focus beside the decorator

In Firefox, Shift-clicking an inline decorator dropped the Lexical selection because `isDOMCapturingSelection` prevented setting `inputState.mouseDrag`. We now allow mouse drag selection for inline decorators and Shift-clicks that do not target embedded inputs, keeping the anchor and adjusting the focus beside the decorator.

Verify: in Firefox, put the caret in text before an inline decorator, Shift+click the decorator and type a character; the character replaces the selection that ends beside the decorator.
