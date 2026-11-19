---
'@lexical/y': patch
---

[fix] Keep an inline element that stays where it was when a write edits the text on both sides of it

A write that edits text on both sides of an inline element (a link or other inline container, an inline decorator) and has no record of the update's text edits, such as an app's edit inside a remote read, or a write recovered after an error, deleted that element and made it again from what the editor shows, losing a collaborator's concurrent edit inside it. The element is now kept, and only the text around it is rewritten. Moving an element to another line is still written as a move.

Verify: while a collaborator types inside an inline element, edit the text before and after it in an app's selection transform during a remote change: the collaborator's text is kept on every client.
