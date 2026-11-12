---
'@lexical/y': patch
---

[fix] While a composition holds a collaborator's change back, a node transform that re-types the text of the line composed in (a code highlighter tokenizing the shown code line again when the composition ends, which makes its text nodes code highlight nodes) is no longer written where the editor shows that line with a type its stored counterpart no longer has: the collaborator had made it another block (a join into a paragraph or list item), and the highlighter's tokens, which keep no format and join NodeState, were stored on that block's text, dropping its formats and spreading comment ids; the line is read again when the hold ends

Verify: while a client composes in a code block, have a collaborator press Backspace at the start of that block to join it into a paragraph holding an underlined word and a commented word; when the composition ends, every client and a fresh reader show the paragraph with the underline and the comment on their own words.
