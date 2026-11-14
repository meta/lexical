---
'@lexical/rich-text': patch
'@lexical/mdast': patch
---

[fix] Leave a shadow root quote line by line with Enter and Backspace, and make the `> ` shortcut create the same quote as Markdown import

Verify: with `MdastShadowRootQuoteExtension`, typing `> a` makes a shadow root quote that holds a paragraph. Enter on an empty line of a shadow root quote moves the line out of the quote (after it, before it, or between the two halves of a split quote). Backspace at the start of the first line, and `QuoteNode.collapseAtStart()`, move only that block out instead of every block.
