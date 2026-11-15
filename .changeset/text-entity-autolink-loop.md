---
'@lexical/text': patch
---

[fix] `registerLexicalTextEntity` avoids transform loops next to AutoLinkExtension when formatting or commenting text adjacent to an email or URL followed by a TLD continuation.

The plain text transform now only marks its next sibling dirty when the sibling contains a matching entity, and avoids marking the same sibling dirty more than once per pending editor state.
