---
'lexical': patch
---

[fix] Confirming a composition after a format change interrupted it, such as Bold tapped mid-word on iOS, no longer loses the composed word when the browser deletes it before committing it

Verify: on iOS 26 with a Japanese Kana keyboard, compose a word, tap a toolbar's Bold, keep composing and confirm; the word stays. A commit without the deletion, as earlier iOS versions sent, still inserts the word once.
