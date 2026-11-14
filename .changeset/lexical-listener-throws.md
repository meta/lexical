---
'lexical': patch
---

[fix] A listener that throws no longer hides a commit from the other listeners: the editor calls every mutation, decorator, text content and update listener of a commit (and every root or editable listener) even after one of them, or the cleanup one returned, throws, then rethrows the first error

A collaboration binding is an update listener, so a commit in which an earlier-registered listener threw (an app's or a plugin's bug) was never stored: the editor showed the change, the document and the other clients did not.

Verify: listeners registered after one that throws now run for that commit, and the commit still throws that listener's error (the first one of the commit's listeners, when several throw) from the same place as before; what that error skipped before is still skipped (the commit's `onUpdate` callbacks, and the updates its listeners queued, which commit with the next update outside a running update). For a commit outside a running update `onError` is not called for a listener's error; a commit forced inside a running update still goes through that update's error handling. A cleanup a listener returned runs once when the editor dispatches it (also when it throws, or under a nested dispatch).
