---
'@lexical/selection': patch
---

[fix] `$wrapNodes` over a range across a block decorator (a horizontal rule) in an element that is not a block container returns, and keeps every paragraph

Verify: in a box element that declares no structure, holding "aa", "bb", a horizontal rule and "cc", select from inside "bb" to the end of "cc" and wrap in quotes: the call returns, "bb", the rule and "cc" are in quotes, and "aa" is untouched.
