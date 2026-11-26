---
'@lexical/html': patch
---

[fix] `$generateNodesFromDOM` imports code pasted from VS Code in Safari as one code block instead of one code block per line

Verify: copy several lines from VS Code in Safari and paste them into an editor that registers CodeNode and uses the default clipboard import; they land as one code block. In an editor without CodeNode, each blank line now becomes a paragraph holding a line break, as a Chrome paste already does.
