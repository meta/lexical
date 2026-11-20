---
'@lexical/y': minor
---

[breaking] `migrateYState` requires a `pending` choice and returns a union on `split`; `prepareYRoom` returns a union on `changed` with everything to store in `write`

A migration's pending material (pending structs, a pending delete set, what follows a skipped range) is never in the migrated state. It was a `pending` field beside `state`, so a caller that kept `.state` dropped it without a compile error. `migrateYState` now requires `options.pending`: `'return'` (the result is `{split: false, state, update, receipt}` or, where the input held pending material, `{split: true, integrated, pending, update, receipt}`) or `'discard'` (never split; the receipt's new `pendingBytes` says how much was dropped). A JavaScript call without the choice throws a `TypeError` that names it. `prepareYRoom` always returns the material: its result is `{changed: false, state, generation, receipt}` or `{changed: true, write: {state, generation, base, pending}, receipt}`.

Detect: calls to `migrateYState(state, steps)` or with options lacking `pending` (TS2769, "No overload matches this call": `Property 'pending' is missing`); reads of `.state`, `.pending` on its result (TS2339, `Property 'state' does not exist on type 'YMigrationResult'`); reads of `.state`, `.generation`, `.base` or `.pending` on `prepareYRoom`'s result (TS2339 on `YPreparedRoom`); Flow `YMigrationResult` and `YPreparedRoom` consumers.

Migration: pass the choice and narrow before reading the state.

```ts
// Before
const {state: migrated, pending} = migrateYState(stored, steps, {roots});
// After (a server that stores the result)
const result = migrateYState(stored, steps, {pending: 'return', roots});
const migrated = result.split ? result.integrated : result.state;
if (result.split) storePendingRecord(stored, result.pending);
// After (a read of a migrated copy)
const readable = migrateYState(stored, steps, {pending: 'discard', roots}).state;

// Before
const prepared = prepareYRoom(stored, {incarnation, roots});
if (prepared.changed) store(prepared.state, prepared.generation, prepared.base, prepared.pending);
// After
const prepared = prepareYRoom(stored, {incarnation, roots});
if (prepared.changed) {
  const {state, generation, base, pending} = prepared.write;
  store(state, generation, base, pending);
}
```
