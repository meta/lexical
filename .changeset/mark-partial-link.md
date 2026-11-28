---
'@lexical/mark': patch
---

[fix] `$wrapSelectionInMarkNode` marks only the selected part of a link when the selection starts before the link and ends inside it, instead of the whole link

Verify: marks created over a selection that starts before a link and ends inside it. The part inside the link is now a separate mark nested in the link, so a custom `createNode` runs once more, and an autolink covered this way is unlinked until the mark is removed.
