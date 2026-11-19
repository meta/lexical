---
'@lexical/y': patch
---

[fix] Open a document read only in `@lexical/y` when a node class throws on its stored content, instead of showing it empty

The binding warns `UNKNOWN_NODE_TYPES_WARNING` with the new reason `'unreadable'` (with `types` and `error`), keeps showing the rest of the document, and throws nothing into the provider's `Y.applyUpdate` or from `initialize()`.
