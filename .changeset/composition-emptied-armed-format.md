---
'lexical': patch
---

[fix] Keep a format or style armed on a collapsed caret (for example with Cmd/Ctrl+B) when an IME empties the composition and then commits it with a plain `insertText`, as ibus-hangul does on Chromium for every Korean syllable; the text used to take the format of the text before it

Verify: on Chromium with ibus-hangul, type `ab`, press Cmd/Ctrl+B and type 한국어: it is bold, as it is with fcitx5 and in an empty editor; the reverse (bold off after bold text) is plain. A format armed before a composition that ends without committing any text now applies to the next typed character too, as it does when no composition happened.
