---
'lexical': patch
---

[feature] Add `$deepCopy` to copy a node together with its children and slots

`$copyNode` copies only the node itself. `$deepCopy(node)` returns a detached
copy of the node and its whole subtree, named slots included, all with new
keys. It keeps NodeState, like a Lexical-JSON paste, and leaves out
descendants that are excluded from clones. Use it for features such as
"Duplicate block".
