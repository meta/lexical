---
'@lexical/y': patch
---

[fix] Keep the fields a newer version of a node class added when a client with the older class moves the node, or splits its line, in `@lexical/y`

Verify: with an older and a newer version of a node class editing one room, a block, list item or inline node the older client moves, or whose line it splits, keeps the fields only the newer class declares, and a list it moves keeps its own fields. The text inside a moved block still loses the text formats and the text-class or link fields the older client does not know. A flat NodeState with no schema, reset on a node stored as its own Y.Node, stays reset for every client.
