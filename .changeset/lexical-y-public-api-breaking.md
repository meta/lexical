---
'@lexical/y': minor
---

[breaking] `@lexical/y` no longer exports `createYCollabConfig`, `YCollabInput`, `createYServerLayoutUpgrade`, `isYLayoutUpgradeHandle`, `YLayoutUpgradeHandle` or `YClientSession`: set up a binding with `yCollab({doc, schemaVersion, synced, onStatus})` or `createYBinding(editor, {...})`, whose `synced` and `onStatus` are required, and send `collab.handshake(generation)` before syncing

Migration: replace `createYCollabConfig({doc, schemaVersion, layoutUpgrade})` with `yCollab({doc, schemaVersion, synced: false, onStatus})` and take `collab` from YCollabExtension's output; call `collab.markSynced()` where you called `binding.initialize()`; replace `layoutUpgrade.handshake({generation, material})` with `collab.handshake(generation)`; `createYServerLayoutUpgrade` and `YClientSession` remain on `@lexical/y/server`.

Detect: `createYCollabConfig`, `YCollabInput`, `createYServerLayoutUpgrade`, `isYLayoutUpgradeHandle`, `YLayoutUpgradeHandle`, `YClientSession` imported from `@lexical/y`
