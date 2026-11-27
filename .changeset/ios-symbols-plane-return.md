---
'lexical': patch
---

[fix] On iOS, Return after a symbol from the software keyboard's #+= plane (such as `%` or `*`) starts a new paragraph instead of inserting a line break

Verify: with the iOS software keyboard, type `10%` and tap Return; a new paragraph starts. Tapping Shift right before Return, or a hardware Shift+Return, still inserts a line break. On a hardware keyboard, holding Shift through other keys and then pressing Enter now starts a paragraph; release Shift and press it again right before Enter for a line break.
