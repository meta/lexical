---
'@lexical/compiler': patch
---

[perf] Treat module-scope `defineMarkExtension` calls from `@lexical/mark` as side-effect free, so bundles drop the mark flavors they do not use
