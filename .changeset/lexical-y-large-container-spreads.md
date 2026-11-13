---
'@lexical/y': patch
---

[chore] The binding no longer spreads a list that grows with the document into a call's arguments (the children of an inline element in a line it writes, the runs of text an edit spans), which a large enough document could make throw `RangeError: Maximum call stack size exceeded` (past roughly 100,000 to 125,000 arguments on V8's main thread, 65,536 on JavaScriptCore); a source test keeps such calls out of the package
