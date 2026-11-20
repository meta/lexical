---
'@lexical/y': patch
---

[fix] Keep every unchanged word of a line whose text nodes an update makes again with several words changed, so a collaborator's concurrent delete between two changed words stays deleted

Verify: an update that removes a line's text nodes and makes new ones with two or more words changed (an agent rewriting a block from its JSON) writes only the changed words. A word a collaborator deletes between two of them at the same time stays deleted, and shows once when the collaborator undoes the delete; a letter a collaborator types into an unchanged word between them stays in that word.
