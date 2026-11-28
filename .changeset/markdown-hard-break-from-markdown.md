---
'@lexical/markdown': patch
---

[fix] Read a hard line break at the end of an imported line from its Markdown, so an escaped backslash and inline code ending in `\` or two spaces no longer gain a hard break, and `a\\\` keeps its hard break

Verify: import `a\\` followed by `b` and `` `a\` `` followed by `b`, which keep their backslash and stay soft line breaks, then export them and import the result again. `a\\\` followed by `b` keeps its hard break.
