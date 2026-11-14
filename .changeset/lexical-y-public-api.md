---
'@lexical/y': patch
---

[feature] A setup API with the choices an app must make required: `createYBinding(editor, {doc, schemaVersion, synced, onStatus})` and `yCollab({...})` (YCollabExtension's `collab` output) return a binding with `markSynced()`, `handshake(generation)`, `history`, `freeze()` and a `status` that carries why it is read only; `Y_DEFAULTS`, `parseYGeneration`, `createYHandshake`, and `describeUnsyncedEdits` on `@lexical/y/headless`. The existing `YBinding` and `createYCollabConfig` keep working
