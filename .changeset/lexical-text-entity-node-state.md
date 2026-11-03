---
'lexical': patch
'@lexical/text': patch
---

[fix] `registerLexicalTextEntity` keeps the NodeState of a text entity (a hashtag, a keyword) that stops matching and becomes text, such as comment ids stored as NodeState, instead of dropping it

The NodeState also comes back when that text is made an entity again in the same update, and plain text keeps its NodeState when it becomes an entity (state that `createNode` gives the entity wins). A token or segmented entity that text follows keeps its NodeState as well: it is turned back into text with it, and after twice in one update (or in updates batched into one commit) it is kept (taking the text its match extends into only when that text would merge with it), instead of looping forever. Editing inside a segmented node (typing, or removing a range that starts or ends in it) keeps its NodeState and detail too.

One case still drops NodeState: typing into a run of repeated characters, when a matcher that looks back into the run makes the run's last existing character an entity (#9725).

Verify: put a comment (or any NodeState) on a hashtag, type right before it or delete its `#`, and check that its characters keep the comment.

Verify also: type inside a segmented mention (or delete a range that starts in it) and check that the text left keeps its NodeState and `unmergeable` detail; paste ` #tag` right after a comment and check that the hashtag is not added to the comment.
