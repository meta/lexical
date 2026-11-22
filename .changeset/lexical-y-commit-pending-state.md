---
'@lexical/y': patch
---

[fix] Commit a pending editor state that holds nothing to commit before reading a remote change, so the read's update tags can no longer make the next local edit go unwritten
