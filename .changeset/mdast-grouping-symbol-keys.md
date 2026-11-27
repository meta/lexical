---
'@lexical/mdast': patch
---

[fix] Keep a symbol-keyed property that an export rule adds to formatted text

Verify: With an export rule for `TextNode` that adds a symbol-keyed property to the `strong` node `context.next()` returns, `$convertToMdast()` should keep that property on the `strong` node (before, the node was built again without it). Such a node is now written on its own, as one with a `data` property already was: bold `ab` carrying the property, followed by bold italic `cd`, exports as `**ab**_**cd**_` instead of `**a&#x62;_&#x63;d_**`, and both read back as the same text and formats.
