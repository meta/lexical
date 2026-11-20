---
'@lexical/list': patch
'@lexical/mdast': patch
---

[fix] Keep GFM task items in bullet and number lists in `@lexical/mdast`, using the new `$getTaskListItemChecked` and `$setTaskListItemChecked` from `@lexical/list`

Verify: Markdown that mixes plain and task items in one list now imports as a bullet list whose task items have checkboxes, not as a check list; ordered task lists keep their checkboxes and are written with `.`.
