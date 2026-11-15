---
'@lexical/text': patch
---

[fix] `registerLexicalTextEntity` avoids transform loops next to AutoLinkExtension when formatting or commenting text adjacent to an email or URL followed by a TLD continuation.

The plain text transform now only marks its next sibling dirty when the combined match starts inside that sibling, and avoids marking the same sibling dirty more than once per pending editor state.

Verify: Formatting or commenting text adjacent to an email or URL followed by a TLD continuation with a text entity registered settles without transform loop errors, while adjacent entities dependent on preceding boundaries (such as hashtags and keywords) continue to be converted when the preceding text changes.
