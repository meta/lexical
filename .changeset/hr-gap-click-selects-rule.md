---
'@lexical/extension': patch
---

[fix] A click in the empty space above or below a horizontal rule selects the rule

Verify: clicks in the space above or below a horizontal rule, including between two adjacent rules, now select the rule instead of placing a caret; check tests that click beside a rule.
