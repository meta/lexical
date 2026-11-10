---
'@lexical/y': patch
---

[fix] A remote change the binding cannot read while the editor composes no longer leaves the format items the composition's hold kept exempt from garbage collection for the document's lifetime

Verify: compose (IME) in a line while a collaborator removes a format in it, make the next remote change fail to read once (the binding recovers and reports `RECOVERED_READ_WARNING`), then collect the document's deleted items: the deleted format items are collected.
