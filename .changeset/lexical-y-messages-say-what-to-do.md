---
'@lexical/y': patch
---

[fix] Warnings that open a document read only, and `YHeadlessError`'s `'read-only'` message, say why and what to do

Verify: code that compares the `message` of a `@lexical/y` warning or `YHeadlessError` with a fixed string. Compare a warning's `code` and `data`, or a `YHeadlessError`'s `code` and its `warnings`, instead: they did not change.
