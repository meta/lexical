---
'@lexical/text': patch
---

[fix] Preserve NodeState when repeated characters make a text entity's insertion boundary ambiguous

Verify: Insert a repeated character before existing text matched by a lookbehind-based entity matcher and check that the existing character keeps its NodeState.
