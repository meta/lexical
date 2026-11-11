---
'@lexical/code-prism': patch
---

[chore] The Prism facade reads the core through its module namespace instead of only the global, keeping the core-first initialization order explicit in bundled output.
