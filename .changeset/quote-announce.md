---
'@lexical/rich-text': patch
---

[feature] Announce block quotes to screen readers by default in rich text

Verify: with a screen reader, type `>` and a space at the start of a paragraph and listen for "Block quote". Press Enter at the end of a quote, or Backspace at the start of the paragraph below it, and listen for "Exiting block quote" or "Block quote". Turn a quote into a heading, or a heading into a quote, and listen for one combined message.
