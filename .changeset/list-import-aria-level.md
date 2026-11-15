---
'@lexical/list': patch
---

[fix] A list pasted from Google Docs keeps its nesting: items Docs writes as one flat list with their depth in `aria-level` import as nested lists

Verify: paste a Google Docs list with second- and third-level bullets or numbered sub-steps; they import indented under their parent items instead of all at the first level. Lists without `aria-level`, or whose items all share one level, import as before.
