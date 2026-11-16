---
'@lexical/y': minor
---

[breaking] `HeadlessYConfig.onWarn` is required: a handler, or `null`

`seedYState` and `readYState` return their warnings nowhere else, and some say content was not stored as the editor had it (`UNSYNCED_VALUE_WARNING`: a NodeState value that is not JSON); with `onWarn` left out they were silent in production. `onWarn` is now required: a function, or `null` for the old behavior (`console.warn` outside production, nothing in production). A JavaScript call without it throws, naming the fix.

Detect: `HeadlessYConfig` objects without `onWarn` passed to `seedYState`, `editYState`, `readYState`, `describeUnsyncedEdits`, `describeYOfflineCapture` or `recoverYOfflineEdits` (TS2741/TS2345, `Property 'onWarn' is missing`).

Migration: route warnings to your logs, or pass `null`.

```ts
// Before
const config = {extensions, schemaVersion: 1};
// After
const config = {extensions, onWarn: warning => log.warn(warning), schemaVersion: 1};
```
