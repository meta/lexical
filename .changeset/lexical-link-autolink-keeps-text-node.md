---
'@lexical/link': patch
---

[fix] `AutoLinkExtension` moves the text it links into the new link instead of a copy, so the text keeps its NodeState (comment ids stored with `MarkStateExtension`, for example), its key and the selection in it

The copy lost every NodeState of the URL's first text node, so text with a comment lost the comment when it became an autolink. With a token or segmented text entity made by `registerLexicalTextEntity`, typing a match inside an autolink whose text has two formats, or opening a stored document where such an entity no longer matches its text after URL text, looped forever ("One or more transforms are endlessly triggering additional transforms"): the entity transforms keep such an entity once it has been turned back into text twice in one update, and they tell it by the node before it, which the copy replaced each time.

Verify: with `MarkStateExtension`, comment text that contains a URL (or type a URL inside a comment) and check that the autolink's text keeps the comment.
