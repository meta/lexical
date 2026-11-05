---
'@lexical/rich-text': patch
---

[fix] Typing while a block decorator such as a horizontal rule is selected puts the text at the start of the block after it, or in a new paragraph if nothing follows, instead of at the top of the document

Verify: select a horizontal rule (click it, or arrow onto it from the paragraph above) and type a letter. The letter appears after the rule.
