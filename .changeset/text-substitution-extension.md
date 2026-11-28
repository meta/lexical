---
'@lexical/extension': patch
---

[feature] Add TextSubstitutionExtension: auto-replace text aliases as you type

Typing `--` now inserts `—`, `(c)` inserts `©`, and so on, with custom substitutions supported. Pressing Ctrl+Z or Backspace right after a substitution reverts it to the original text.
