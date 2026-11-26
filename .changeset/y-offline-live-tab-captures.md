---
'@lexical/y': patch
---

[fix] A page no longer captures another open tab's unsynced edits as its own when the epoch moved

`loadYOffline` loads a tab's rows while that tab is still open (so a page shows what another tab holds). With a tab left open offline at an older epoch, every new page bound to those rows, met the room's new epoch and stored a capture of the other tab's edits, again on every page load. `YOfflineLoaded` now says when the unsynced edits loaded are only a live tab's (`unsyncedInLiveTabs`), and the session captures nothing of them on a moved epoch unless the page edits too, removing only the rows it wrote (a store of your own can implement the new optional `YOfflineSlot.discardWritten`; without it the session falls back to `discard()`); that tab captures its own when it learns the epoch moved. Such a page stores no row until its first own edit (which stores the whole document) or its `markSynced()`, so a page that closes, with or without `dispose()`, leaves no copy of the tab's edits to be read as a closed tab's. After a `'moved'`, load the fresh document with the new epoch (`loadYOffline({epoch})`).

Verify: with a tab left open offline at an older epoch, opening the document in new tabs (once the room has a new epoch) adds no capture; the old tab's edits are captured once, when it reconnects.
