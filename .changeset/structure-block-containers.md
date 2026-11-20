---
'lexical': patch
'@lexical/extension': patch
'@lexical/list': patch
'@lexical/markdown': patch
'@lexical/mdast': patch
'@lexical/selection': patch
'@lexical/utils': patch
---

[feature] With `NodeStructureExtension`, a node class that declares `children: 'block'` is a block container: structural commands convert, wrap, split and insert blocks inside it instead of replacing or splitting it, and `$isBlockContainer` tells whether a node is one

The commands that stopped only at the root or a shadow root now also stop at such a node: `$insertList`, Enter in an empty list item, `$wrapNodes`, `RangeSelection.insertNodes` and `insertParagraph`, `$insertNodeToNearestRoot` and `$insertNodeToNearestRootAtCaret`, and the `@lexical/markdown` and `@lexical/mdast` block shortcuts, and with the selection in an empty one, `$setBlocksType` puts the new block in it. The rule applies wherever node structure is enforced: `NodeStructureExtension` (unless disabled), `registerNodeStructure`, and every `@lexical/y` binding. It is not a selection boundary: select-all, the arrow keys, and Backspace or Delete at its edges behave as before. Classes that declare nothing, and editors that do not enforce node structure, keep the current behavior, with three fixes: `$insertList` no longer replaces an empty container (a shadow root or a declared container) that a range passes over, nor the container of a selected block decorator; `$wrapNodes` on an empty root or shadow root puts the new block in it instead of replacing it (on an empty root it threw); and where node structure is enforced, `$insertList` in a box that also holds a block a list item cannot hold (a quote, another box) turns the paragraph (or heading, or quote) holding the selected text into a list in place, inside the box, instead of dropping the list.

Verify: declare `children: 'block'` on a callout-like container, run `NodeStructureExtension`, and check that turning one of its paragraphs into a list, a heading via a markdown shortcut, or pasting several paragraphs into one keeps the container and its other blocks.
