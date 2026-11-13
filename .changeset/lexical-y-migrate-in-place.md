---
'@lexical/y': patch
---

[feature] `migrateYDoc` and `MIGRATION_ORIGIN` from `@lexical/y/migrate`: an editor tab can migrate the live room it has open in place, and the update syncs to the other peers as an ordinary Yjs update. A tab of the same build bound below the floor becomes editable when it arrives, without a rebind; a tab of an older build turns read only (`'newer'`); two tabs that migrate the same state write the same update. A format or NodeState change that an older build's tab made before the update reached it, in a container the migration rewrote, can be lost (see "Migrating a live room in place" in the docs)
