---
'lexical': patch
---

[fix] End the editor's composition when Chromium ends it without a compositionend event: an app's update during an IME composition that moved the composing text (unwrapping its link, moving its paragraph) left the editor composing, dispatching no key commands

Verify: in desktop Chromium, start an IME composition in a link's text, run an `editor.update()` that unwraps the link, then type: `editor.isComposing()` is false and key commands (Enter, Backspace) dispatch again.
