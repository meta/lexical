---
'@lexical/y': patch
---

[feature] `@lexical/y/migrate/4to5`, the frozen, parameterless layout migration step from layout 4 to layout 5, and whole-root steps (step contract 2, `YLayoutRootMigration`): it rewrites each quote that holds paragraphs as the container layout 5 stores, keeping every block's type, fields, NodeState and block id, leaves every other part of the room as it is, and is checked by the runner on a read of the whole root before and after, and on layout 5's invariant (`checkAfter`). A room without such a quote gets only its layout record and epoch
