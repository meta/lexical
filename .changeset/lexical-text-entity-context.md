---
'@lexical/text': patch
---

[fix] Stop `registerLexicalTextEntity` transforms from looping when text is typed between two text nodes of another format

Verify: with a text entity registered (a hashtag or keyword plugin), type a space inside a word of plain text that sits between two bold text nodes. The update goes through, and an entity is made only where its match holds next to the text before it.
