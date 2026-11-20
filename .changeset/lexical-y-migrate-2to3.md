---
'@lexical/y': patch
---

[feature] `@lexical/y/migrate/2to3`, the frozen layout migration step from layout 2 (and, after `1to2`, layout 1) to layout 3: it rewrites each container's format runs as layout 3's paired runs that show exactly what the document showed before, in place, keeping every content id, marker attribute and flat NodeState item, and checks layout 3's invariants on the result (`checkAfter`)
