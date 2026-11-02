---
'@lexical/html': patch
---

[fix] `BlockIdHTMLExtension` keeps the id of a list item that only wraps a nested list through an HTML round trip, in a `data-block-wrapper-id` attribute on the nested list

Verify: with `BlockIdHTMLExtension`, export a list with a nested list and import the HTML into another editor: the item that wraps the nested list keeps its id, like every other list item.
