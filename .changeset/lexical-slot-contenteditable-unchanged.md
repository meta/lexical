---
'lexical': patch
---

[perf] Reconciling a decorator host with named slots no longer rewrites an unchanged `contentEditable` on its slot containers, which in Chrome forced a synchronous style recalculation on every such reconcile
