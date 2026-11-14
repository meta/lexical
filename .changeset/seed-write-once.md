---
'@lexical/y': patch
---

[perf] `seedYState` and a client's `initialize()` of a new document write the initial content once instead of twice

The bytes are unchanged: the same items, ids, origins, segment and instance keys, and formats as the second write produced.
