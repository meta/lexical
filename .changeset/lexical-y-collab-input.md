---
'@lexical/y': patch
---

[feature] `YCollabInput`, the input of `createYCollabConfig`: `doc`, `schemaVersion` and `layoutUpgrade` are required and every option with a default is optional, so options a later release adds never break code typed with it. `YCollabConfig` (what `configExtension(YCollabExtension, ...)` takes) keeps its fields, and any field a later release adds to it is optional too
