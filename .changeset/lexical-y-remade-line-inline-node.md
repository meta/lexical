---
'@lexical/y': patch
---

[fix] Stop throwing when an update makes again the nodes of a line holding an inline node whose `isInline()` reads the node's latest version

Verify: removing a line's children and appending new ones made from their JSON, in a bound editor, where the line held an inline decorator or element whose class computes `isInline()` from `getLatest()` (as the playground's `EquationNode` does), writes the new line instead of throwing that the node does not exist in the active editor state.
