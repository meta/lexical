---
'@lexical/y': patch
---

[docs] Narrow a binding warning's `data` with `isYWarning(value, CODE)`: comparing `value.code` after `isYWarning(value)` leaves `data` unknown, because the warning code is open
