---
'lexical': patch
'@lexical/extension': patch
'@lexical/react': patch
'@lexical/rich-text': patch
---

[feature] Shift-click extends a range from a selected node to text or another selectable node. When several nodes are selected, Shift-clicking text extends from the most recently added node still selected. Ctrl-click (Command-click on Apple platforms) toggles individual nodes. `@lexical/extension` exports the experimental `$handleDecoratorClickModifiers` helper for custom click handlers.

Verify: Shift-click a horizontal rule or the outer container of an alignable decorator block from a text caret and confirm that the range includes the node. Plain-click that node and confirm that it becomes the sole node selection. Shift-click into the paragraph above it, extend with Shift+ArrowLeft, then Shift-click earlier text and press Backspace. The paragraph below the node should stay separate. Try Shift-clicking beside an inline decorator or in an empty paragraph. Selecting one image and Shift-clicking another now selects everything between the images. Select two nodes with Ctrl-click (Command-click on Apple platforms), then Shift-click text. Reversing the order in which the nodes were selected should change the start of the range. A canceled Shift-mousedown in rich text should preserve the node selection.
