---
'@lexical/plain-text': patch
---

[fix] Move the caret to the side of a node-selected decorator on an arrow key, as rich text does, so what is typed next no longer goes to the top of the document

Verify: in a plain-text editor with a decorator that can be node-selected (for example `HorizontalRuleExtension`), click the decorator and press each arrow key. The caret moves beside the decorator (ArrowUp and ArrowLeft before it, ArrowDown and ArrowRight after it) and the next typed character is written there. With Shift, a contiguous node selection becomes a range that the key extends.
