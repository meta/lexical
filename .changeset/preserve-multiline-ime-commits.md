---
'lexical': patch
---

[fix] Preserve multiline text committed by an Android input method into existing text.

Verify: In Android Chrome, put the caret after existing text and insert a two-line clipboard entry using the Fcitx5 keyboard's clipboard panel. Both lines should be inserted.
