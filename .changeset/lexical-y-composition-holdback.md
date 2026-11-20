---
'@lexical/y': patch
---

[fix] Keep the line being composed with an IME unchanged while collaborators add to it, and show every held change exactly once after composition ends, also after Enter or a paste made while composing

Verify: IME composition (Chinese, Japanese or Korean input) in a paragraph a collaborator edits at the same time: the composition is not interrupted, and what they typed, formatted, split or pasted there shows when it ends. Check that a held insert followed by a multi-paragraph paste appears exactly once after composition ends, and that held collaborator inline formatting is visible when composition ends and Enter is pressed in the same update. With BlockIdExtension enabled, pasted lists and their items must agree with the block IDs stored in the document.
