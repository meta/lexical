---
'@lexical/y': patch
---

[feature] Store set-valued NodeState (such as `MarkStateExtension`'s `markIds`) one entry per member in `@lexical/y`, so concurrent additions and removals of different members merge
