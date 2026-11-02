---
'lexical': patch
---

[fix] Discard an update that throws also when `onError` rethrows the error, so the next update no longer commits its changes and update tags

Verify: with an `onError` that rethrows (the default of `buildEditorFromExtensions`), an `editor.update()` whose callback, nested update, transform or selection change listener throws now leaves the editor at its last committed state, as an `onError` that only reports the error already did, and the next update commits only its own changes. With either kind of `onError`, the failed update is discarded before `onError` runs (a read in `onError` sees the committed state), the updates it queued are dropped with it, an update nested in it reports its error once, and a commit made during it (by `setEditorState`, or by a read that commits) now stays instead of being reverted. When restoring the editor throws too, the caller still gets the error `onError` rethrew.
