---
'@lexical/rich-text': patch
---

[fix] Typing while a block decorator such as a horizontal rule is selected puts the text on a line of its own right after it (an empty paragraph or heading already there, or a new paragraph), instead of at the top of the document

Verify: select a horizontal rule (click it, or arrow onto it from the paragraph above) and type a letter. The letter starts a new paragraph right after the rule; the paragraph that followed the rule is unchanged.
