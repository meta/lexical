---
'@lexical/y': patch
---

[fix] Keep a range selection when a collaborator's change shortens, splits or replaces the text node it is in

A collaborator's delete before the range (as long as the range or longer),
a format, comment or link starting at the range's start, a link on a word
before it, or Enter right after it collapsed the selection to a caret on
the other client, so the next format or comment command applied to nothing.
Whether the selection is a caret is now decided on what the editor showed
before the remote change was read, not after the read changed the nodes the
range is in. A caret the user collapsed is still never widened into a range.

Verify: a selection that a remote change touches at its edges keeps the
same text selected.
