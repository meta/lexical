---
'@lexical/code-prism': patch
---

[fix] The Prism core initializes before its language components in bundled output, so a production client build no longer throws `Prism is not defined`. The facade now reads the core through its module namespace instead of only the global, which pins the initialization order; the exported `Prism` value is unchanged.

Verify: build any app that bundles `@lexical/code-prism` for production (e.g. Vite/Rolldown) and load a route that highlights code — no `Prism is not defined`, languages highlight.
