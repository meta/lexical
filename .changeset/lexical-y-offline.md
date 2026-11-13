---
'@lexical/y': patch
---

[feature] `@lexical/y/offline`: a local store for Yjs 14 documents on IndexedDB (`openYOfflineStore`, keyed by a document key and the epoch it was made against, with quota, corruption and refuse-never-evict `limits` as typed results) and an offline session (`attachYOfflineSession`) that stores every edit as it is made, lets it sync at the same epoch, and on a moved epoch (a replaced or upgraded room) freezes and captures it for `recoverYOfflineEdits` and `replayUnsyncedEdits`, behind the stages `'off'`, `'persist'` and `'replay'`
