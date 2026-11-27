---
'@lexical/y': minor
---

[breaking] `@lexical/y/offline`: `markSynced()` moves to `serverEpoch()`'s `'same'` verdict, and `attachYOfflineSession` requires `loaded`, `stopSync` and one `offline` value instead of `stage`, `store`, `persistEdits` and `keep`

`session.markSynced()` could run on a document loaded from the store before the session confirmed the room's epoch: its unsynced edits became the base, so when the room had been replaced the capture was null and the stored rows were deleted. It now exists only on a `'same'` verdict (`verdict.markSynced()`). A `'moved'` verdict could be ignored while the provider kept syncing the frozen document into the room that replaced it: the session now calls the required `stopSync` itself, right after it freezes the binding. `loaded` is required (`null` for a document not created from `loadYOffline`): left out, a loaded document started with no base and nothing unsynced. `stage`, `store`, `persistEdits` and `keep` became `offline: {stage: 'off'} | {stage: 'persist' | 'replay', store, persist: 'document' | 'unsynced' | 'captures-only'}`, so a store is there exactly when the stage uses one and `persist` (formerly `persistEdits: false` or `keep`) is an explicit choice. JavaScript callers that omit any of these get a `TypeError` that names the fix.

Detect: `session.markSynced()` (TS2339 on `YOfflineSession`); `attachYOfflineSession({... stage, store ...})`, `persistEdits` or `keep` (TS2353, "Object literal may only specify known properties"); calls without `loaded`, `offline` or `stopSync` (TS2741/TS2345); `loaded: undefined`; `expect(verdict).toEqual({kind: 'same'})` in tests (the verdict now carries `markSynced`).

Migration: confirm the epoch, then mark synced from the verdict; pass the mode as one value.

```ts
// Before
const session = attachYOfflineSession({binding, store, key, epoch, loaded, stage, onError});
await session.serverEpoch(epoch);
session.markSynced();
// After
const session = attachYOfflineSession({
  binding,
  epoch,
  key,
  loaded, // or null
  offline: store === null ? {stage: 'off'} : {persist: 'document', stage, store},
  onError,
  stopSync: () => provider.destroy(),
});
const verdict = await session.serverEpoch(epoch);
if (verdict.kind === 'same') verdict.markSynced();
```

`persistEdits: false` becomes `persist: 'captures-only'`; `keep: 'unsynced'` becomes `persist: 'unsynced'`. The sync-then-bind flow calls `await session.serverEpoch(epoch)` once after attaching (it answers `'same'` at once) to get the verdict.
