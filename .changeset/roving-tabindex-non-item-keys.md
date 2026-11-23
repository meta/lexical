---
'@lexical/a11y': patch
---

[fix] `RovingTabIndexExtension` leaves arrow, Home and End keys to a focused element inside the group that is not one of its items, such as an input in a toolbar

Verify: arrow, Home and End keys in an input or other non-item control inside a registered roving container keep their native behavior, and an arrow key on the focused container itself still moves focus to the first item.
