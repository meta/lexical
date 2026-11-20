---
'@lexical/table': patch
---

[fix] Pasting HTML with a table cell made bold, italic, underlined or struck through by its own style no longer removes that format from text inside the cell that already has it, such as `<td style="font-weight: bold"><strong>Total</strong></td>`

Verify: paste a table whose `<td style="font-weight: bold">` holds `<b>` or `<strong>` text, or `<td style="font-style: italic">` holds `<em>` text: the text stays bold or italic, as it was in the source.
