---
'@lexical/y': patch
---

[fix] Write a block reorder as a move of the block Lexical moved, so that a collaborator's concurrent typing and caret in a block it passes stay in that block

Verify: concurrent edits around a dragged block. The blocks it passes keep a collaborator's typing and caret. Text typed in the moved block itself at the same time is lost or lands at its old position, and undoing the move takes back what collaborators typed in the moved block since (the Moves limit in the collaboration docs); this now holds also when the moved block is larger than the blocks it passes.
