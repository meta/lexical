---
'@lexical/y': minor
---

[breaking] A status handler and the sync choice are required: `YBindingOptions.onStatus`, `YCollabInput.onYStatus` and `YCollabInput.synced`, and `YCollabExtension` throws at build without `onYStatus`

Without a status handler an app never showed a read-only document's cause; read only with `unstorable-change`, the editor holds an edit the document does not, and an app that never learns it never takes it (`freeze()`), so it was lost on reload. `YBindingOptions.onStatus` and `YCollabInput.onYStatus` are now required (a function, or `null` where the app reads the status another way), and so is `YCollabInput.synced` (a forgotten `markSynced` left the editor pending for good). A config's fields cannot be required by its type, so `configExtension(YCollabExtension, ...)` without `onYStatus` throws at build, naming the fix, and `new YBinding` without `onStatus` throws from JavaScript. `createYBinding` and `yCollab` already required `onStatus` and `synced`.

Detect: `createYCollabConfig({...})` without `onYStatus` or `synced` and `new YBinding(editor, doc, {...})` without `onStatus` (TS2345/TS2741, `Property 'onYStatus' is missing`); `configExtension(YCollabExtension, {...})` without `onYStatus` compiles (an extension's config is partial by design) but throws when the editor is built ("YCollabExtension needs onYStatus"): `@lexical/eslint-plugin`'s new `@lexical/y-collab-status` rule (in its recommended config) reports each such call that passes `doc`; without the plugin, find every call with `grep -rn 'configExtension(YCollabExtension' src` and check that each passes `onYStatus` or overrides a `yCollab(...)` / `createYCollabConfig(...)` dependency, and run one test that builds each editor. A `configExtension(YCollabExtension, {...})` that only overrides options of a `yCollab(...)` or `createYCollabConfig(...)` dependency keeps that dependency's handler and needs no change.

Migration: pass a handler that shows the user the status (or `null` where the extension's new `yStatus` signal, or `binding.status`, is read instead), and say whether the document is synced.

```ts
// Before
createYCollabConfig({doc, layoutUpgrade: null, schemaVersion: 1});
configExtension(YCollabExtension, {doc, schemaVersion: 1, synced: true});
new YBinding(editor, doc, {schemaVersion: 1});
// After
createYCollabConfig({doc, layoutUpgrade: null, onYStatus: showStatus, schemaVersion: 1, synced: false});
configExtension(YCollabExtension, {doc, onYStatus: null, schemaVersion: 1, synced: true});
new YBinding(editor, doc, {onStatus: showStatus, schemaVersion: 1});
```
