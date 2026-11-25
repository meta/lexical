---
'lexical': patch
---

[fix] Backspace at the start of the first block collapses it in a headless editor instead of throwing `window object not found`, and `RangeSelection.modify` no longer throws when the editor has no window

Verify: in an editor with no root element (such as `createHeadlessEditor`), dispatch `DELETE_CHARACTER_COMMAND` with `true` at the start of a quote that is the root's first child: it becomes a paragraph instead of throwing. Character, word and line deletion elsewhere in a block, and `RangeSelection.modify`, now do nothing instead of throwing.
