---
'@lexical/y': patch
---

[feature] `@lexical/y/migrate/3to4`, the frozen, parameterless layout migration step from layout 3 to layout 4: it rewrites each container's format runs, NodeState values on text included, as layout 4's paired runs that show exactly what the document showed before, in place, keeping every content id, marker attribute and reserved end shape, and checks layout 4's invariants on the result (`checkAfter`). A container that holds no NodeState value on text and already meets layout 4's invariants keeps its bytes
