---
'lexical': patch
'@lexical/markdown': patch
'@lexical/selection': patch
---

[fix] Markdown export keeps format markers balanced around a space whose formats differ from the text beside it

Closing markers such as `**`, `*` or `~~` were dropped, repeated or placed after the space, so `**_a_ [b](u)**` exported as `***a* [**b**](u)`. `$convertSelectionToMarkdownString` also closes every marker when the selection ends inside formatted text. Empty inline code, such as inline code a selection only touches, is left out. Export stays linear in the length of a run of formatted spaces, and `$convertSelectionToMarkdownString` no longer works out the selection's nodes or range again for every node it exports. `LexicalNode.isSelected`, asked repeatedly of a selection that caches its nodes, looks the node up in a cached set of their keys instead of scanning them each time. `$sliceSelectedTextNodeContent` returns a node that no text point is in without working out the selection.

Verify: Markdown export, including of selections, of text where a space carries different formatting than the words around it.
