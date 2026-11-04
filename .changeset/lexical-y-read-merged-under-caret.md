---
'@lexical/y': patch
---

[fix] A remote change read into an editor with a root element runs no node transforms when the text it leaves merges under the caret, so the editor keeps showing what the document stores

A read can leave two text nodes side by side that Lexical merges at the end of the update (they differ only in what the binding stores for them), and the caret can be in the second one. The merge moved the caret after the binding had counted the read's selection as notified, so Lexical extended the read's commit with the selection change command and ran every node transform over what the read brought: a code highlight outside a code block, for one, became plain text in that editor only, and stayed so, while every other client and a fresh read of the document showed the code highlight. The read's selection now counts as notified as the merge leaves it.
