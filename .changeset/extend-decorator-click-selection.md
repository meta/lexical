---
'@lexical/extension': patch
'@lexical/react': patch
---

[feature] Extend text selections with Shift-click and toggle node selections with Ctrl-click or Command-click on horizontal rules and alignable decorator blocks. `@lexical/extension` exports the experimental `$handleDecoratorClickModifiers` helper for custom click handlers.

Verify: Shift-click a horizontal rule or the outer container of an alignable decorator block from a text caret and confirm that the range includes the node. Plain-click that node while the range still includes it and confirm that it becomes the sole node selection. Use Ctrl-click (Command-click on Apple platforms) on two selectable nodes and confirm that both can be selected and toggled independently.
