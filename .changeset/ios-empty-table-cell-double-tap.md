---
'@lexical/table': patch
---

[fix] Double tapping an empty table cell on iOS no longer selects back to the text before the table

On iOS, an empty cell that was just tapped is briefly covered so the second tap of a double tap cannot start a word selection, and the caret is hidden while a finger is down on a table cell, which reduces its flicker during a long-press drag across cells.

Verify: on an iPhone, double tap an empty cell (also one that already holds the caret); single tap, long press and long-press drag across cells still behave as before.
