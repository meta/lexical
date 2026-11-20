---
'@lexical/mdast': patch
---

[feature] Type `---`, `***` or `___` on its own line, then Space or Enter, to insert a horizontal rule with `MdastShortcutsExtension`

Verify: with `MdastHorizontalRuleExtension` (part of `MdastCommonMarkExtension`), a line that is only `---`, `***` or `___` becomes a horizontal rule on Space or Enter, with the caret on a new line below; a line with text after the marker, or in a table cell, stays text.
