---
'@lexical/text': patch
---

[fix] `registerLexicalTextEntity` no longer loops forever ("One or more transforms are endlessly triggering additional transforms") when typing splits text that sits between two text nodes of other formats, such as a keyword in plain text between two bold words

A match at the start of a text node is now left as text when the text node before it would turn it straight back into text.

A hashtag or other entity right after text in another format is now turned back into text when typing makes it touch that text (`b#tag`), as a fresh parse would.

A token or segmented entity with text after it in its node no longer loops forever: after it is turned back into text twice in one update (or in updates batched into one commit), it is kept.

Verify: text entities (hashtags, mentions, keywords) right after text in another format or style, before and after typing next to them.
