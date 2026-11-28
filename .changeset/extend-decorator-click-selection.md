---
'lexical': patch
'@lexical/extension': patch
'@lexical/react': patch
'@lexical/rich-text': patch
---

[feature] Shift-click extends a range from a selected node to text or another selectable node. When several nodes are selected, Shift-clicking text extends from the most recently added node still selected. Ctrl-click (Command-click on Apple platforms) toggles individual nodes. `@lexical/extension` exports the experimental `$handleDecoratorClickModifiers` helper for custom click handlers.

Verify: This changes clicks on `HorizontalRuleExtension`, `HorizontalRuleNode` from `@lexical/react` and `BlockWithAlignableContents`. Shift-click from one selected node used to add the clicked node to the `NodeSelection`. It now selects the range between them, so use Ctrl-click (Command-click on Apple platforms) to select several nodes. Ctrl/Cmd-click used to select only the clicked node; it now toggles it in the current `NodeSelection`. Shift-click one of these nodes from a text caret and confirm that the range includes it. Plain-click it and confirm that it becomes the only selected node. Select it, Shift-click into the paragraph above, then press Backspace: the paragraph below the node should stay separate. Shift-clicking beside text or in an empty paragraph should also extend the range. Select two nodes with Ctrl/Cmd-click, then Shift-click text: the range starts at the node selected last. A Shift-mousedown that a listener cancels should leave the node selection unchanged.
