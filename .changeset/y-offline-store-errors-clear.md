---
'@lexical/y': minor
---

[breaking] `@lexical/y/offline`: `YOfflineError` is a union by `code`, and `store.clear` requires `slots` and `captures`

`YOfflineError`'s `salvage`, `epoch` and `limit` were optional on every code, so a `'corrupt'` handler was never told the readable rows existed. The error is now a union by `code` (and `where` for `'corrupt'`): a corrupt slot (`where: 'slot'`) carries a required `epoch` and `salvage` (recovery's `captureSlot` now computes one too), unreadable captures (`where: 'captures'`) carry `unreadable`, `'newer'` carries `epoch` and `'limit'` carries `limit`. `store.clear(key, {captures})` without `epoch` deleted every slot of the key, other epochs' and other tabs' unsynced edits included, and the store's own message for unreadable captures prescribed that call. `clear` now takes required `slots` (`{epoch}`, `'all'` or `'none'`) and `captures` (`'all'`, `'unreadable'` or `'none'`); a JavaScript call in the old shape throws a `TypeError` that names the fix.

Detect: reads of `error.salvage`, `error.epoch` or `error.limit` without narrowing on `error.code` (TS2339 on `YOfflineError`); `store.clear(key, {captures: true | false})` or with `epoch` (TS2322/TS2353 on `YOfflineClear`); custom `YOfflineStore` implementations that build errors.

Migration: narrow, then read; name what `clear` deletes.

```ts
// Before
if (error.code === 'corrupt') offer(error.salvage?.state);
await store.clear(key, {captures: false, epoch: error.epoch});
await store.clear(key, {captures: true});
// After
if (error.code === 'corrupt' && error.where === 'slot') {
  offer(error.salvage.state);
  await store.clear(key, {captures: 'none', slots: {epoch: error.epoch}});
}
await store.clear(key, {captures: 'all', slots: 'all'}); // a document no longer needed
await store.clear(key, {captures: 'unreadable', slots: 'none'}); // unreadable captures only
```
