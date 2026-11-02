---
'@lexical/y': patch
---

[fix] Keep the unchanged start and end of a line whose text nodes an update makes again with other text, so a collaborator's concurrent edit there stays where it was made

Verify: an update that removes a line's text nodes and makes new ones with one word changed (an agent rewriting a block from its JSON, a highlighter making a line's tokens again) writes that word alone (and a word joined to it through an inline node with no space between). A letter a collaborator types into another word of the line at the same time stays in that word, a character a collaborator deletes there stays deleted, and a collaborator's concurrent replacement of a word the update replaced, or edited between two letters or digits, leaves both words whole; an edit at a word's edge or next to punctuation merges as typed text does.
