---
'@lexical/y': patch
---

[feature] `@lexical/y/offline` merges a block that both the user and someone else changed, three ways inside the block, when their changes do not overlap: `describeUnsyncedEdits` reports each block's `resolution` (`'whole'`, `'merged'` or `'conflict'`, with `merged` and `conflict`), and `replayUnsyncedEdits` and `recoverYOfflineEdits` apply the merged blocks; `blockMerge: false` keeps every such block a conflict

Verify: at stage `'replay'`, a block changed both in a capture and in the room is now written with both changes when they are apart in the block (it was left for the panel), and such a block is in `inDocument` afterwards. An Offline edits panel that lists `report.blocks` shows fewer blocks; one that offers Reapply by `replayable` can also offer it for `resolution === 'merged'`. Pass `blockMerge: false` to `recoverYOfflineEdits` for the behavior before.
