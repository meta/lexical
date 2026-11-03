---
'@lexical/y': patch
---

[feature] `replayYRecovery` in `@lexical/y/server` (experimental) replays a quarantine record's own changes onto the current document as a checked edit, by Yjs identity: inserts and deletions apply, a format or attribute change applies only where its base value is proven and still current, and the rest is reported as conflicts; `recoveryYState` returns the state a recovery view renders for a record (render only: its source view migrated on a scratch copy through any gap)
