---
'@lexical/y': patch
---

[perf] Check typed text for a lone surrogate half in `@lexical/y` without building a new string where the runtime has `String.prototype.isWellFormed`

Verify: typing in a long text node that holds an emoji costs no more than in one without it.
