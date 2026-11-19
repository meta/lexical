---
'@lexical/code-core': patch
'@lexical/code': patch
---

[fix] Tab and Shift+Tab indent and outdent the lines of a code block without a highlighter, made of plain text nodes, instead of throwing "Expected selection to be inside CodeBlock and consisting of CodeHighlightNode, TabNode and LineBreakNode"

Verify: with `CodeIndentExtension` and no syntax highlighting, select two lines of a code block and press Tab; both lines start with a tab and the focus stays in the editor. Shift+Tab removes the tabs again, also with a collapsed caret, and strips leading spaces when `tabSize` is set. A line made of several text nodes, such as one with bold text, is indented from its first node. `$outdentLeadingSpaces` accepts any `TextNode`.
