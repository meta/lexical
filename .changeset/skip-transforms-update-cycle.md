---
'lexical': patch
---

[fix] `skipTransforms` holds for the whole update cycle: an update that joins the pending state of an update made with it runs no node transforms either, including the revert of DOM changes the mutation observer recorded, which runs as that state commits

Before, that revert (and an update queued after it in the same task) ran every node transform over what the skipping update had changed. With `@lexical/y`, a collaborator's change read while the editor's DOM held an unprocessed change (a decorator rendering, for one) had its tables padded in that editor only, and words typed into the padding cells never reached the other clients.

Verify: an update made with `skipTransforms`, while the editor's DOM has a change Lexical has not processed (append an element to the root just before it), runs no node transforms; updates in the next cycle run them as before.
