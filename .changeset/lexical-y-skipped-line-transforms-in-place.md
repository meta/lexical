---
'@lexical/y': patch
---

[fix] Write what a held line's transforms make once the hold ends, where it stays in that line: where a collaborator changed the block type of a line (or joined it into the line before it) while another client composed in it with an input method, the binding ran the line's transforms again once the line was read as stored, but wrote only what agreed with the update that ended the composition, so a code block a collaborator made stayed untokenized where only the composing client highlights, and an app's transform for headings (bold) did not apply to a line a collaborator made a heading. Now what those transforms make in that line, in place (how its characters are typed, not its text), is written as the composer's own edit, in the composer's undo step; where they would restructure the document, change or move the line's text (move a text node past another, even of equal text), change another block, remove a decorator or a link, or leave a text format no reader shows, nothing is written and the line stays as stored.

Where the transforms run again both change the line's text and re-type it (an app's transform that upper-cases text in a heading, beside a hashtag), nothing of the line is written, so a hashtag that was written there before is no longer written.

Verify: with two clients, A composes a hashtag in a paragraph while B makes it a code block, and only A runs a code highlighter; when A's composition ends, every client shows the line as A's highlighter's tokens (before, as plain text). A composition that ends with no collaborator's change in its line stores the same as before.
