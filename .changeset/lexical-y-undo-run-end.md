---
'@lexical/y': patch
---

[fix] Stop a format, comment or link from spreading to the end of the document in `@lexical/y` when a collaborator edits inside it while it is undone or its end is deleted

Verify: undo a format, a comment or a link, or delete the text at its end, while a collaborator types, pastes or changes a format inside it; on every client, no text past it gets the value.
