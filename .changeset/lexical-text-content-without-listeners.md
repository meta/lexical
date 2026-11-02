---
'lexical': patch
---

[perf] A commit no longer computes the whole document's text when no text content listener is registered, which made every update of a large headless editor cost time proportional to the document
