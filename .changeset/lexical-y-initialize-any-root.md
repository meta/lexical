---
'@lexical/y': patch
---

[fix] Two clients that initialize a root inside another shared type, or a root that held content before, at the same time write the initial content once, as for a new document

Verify: load the same room in two clients whose binding's `root` is a `Y.Node` inside an app map (or whose root was emptied), call `initialize()` on both before they sync, and check that the content shows once.
