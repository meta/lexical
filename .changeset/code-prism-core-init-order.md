---
'@lexical/code-prism': patch
---

[fix] The Prism core initializes before its language components in bundled output. The facade now reads the core through its module namespace instead of only the global, which keeps the initialization order explicit; the `Prism` value the facade exposes is unchanged.

Verify: bundle any app that includes `@lexical/code-prism` for production (e.g. Vite/Rolldown) and load a route that highlights code — languages highlight with no `Prism is not defined`.
