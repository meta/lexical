---
'@lexical/markdown': patch
---

[fix] Import a line that starts with three backticks and has more backticks later as a paragraph, not as a code fence, so inline code that Lexical exports at the start of a paragraph no longer becomes a code block that takes the rest of the document

Verify: import `` ``` a``b ``` x `` followed by a blank line and `next`, which gives a paragraph with inline code and then a separate `next` paragraph. Typing three backticks and a space at the start of an existing paragraph still makes a code block.
