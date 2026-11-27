---
'@lexical/mark': patch
---

[fix] `MarkStateExtension` keeps the comment ids of text that a block type or list change moves into another block

Turning a list item into a paragraph, quote, heading or code block (`$setBlocksType`), or a paragraph into a list item that joins the list above it (`$insertList`), no longer removes comment ids from its text or gives it the ids of a neighbouring item, also when text is typed in the same update.

Verify: convert commented text between block types and lists, with the caret in it, and check that every character keeps its comment ids. A TextNode that code moves (rather than creates) into the middle of a marked run now keeps exactly its own ids instead of taking the run's.
