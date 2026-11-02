---
'@lexical/html': patch
---

[perf] `BlockIdHTMLExtension` no longer runs its export middleware for each exported element while `export` is off: the override is left out of the export session
