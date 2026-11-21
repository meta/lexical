---
'@lexical/plain-text': patch
'@lexical/rich-text': patch
---

[fix] Arrow keys on a node-selected decorator in plain text move the caret beside it, as in rich text, and an arrow key pressed in a node-selected decorator's own input is left to that input in both

Verify: in a plain-text editor, select a horizontal rule or an inline decorator, press an arrow key and type; the text lands beside the node, not at the top of the document, and Shift with an arrow key extends a selection from the node. In a decorator that renders its own `<input>`, select the decorator, click into the input and press an arrow key; the input's caret moves.
