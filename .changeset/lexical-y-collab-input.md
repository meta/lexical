---
'@lexical/y': patch
---

[feature] `YCollabInput`, the type to write a `YCollabExtension` config with: `doc` and `schemaVersion` are required and every option with a default is optional, so options a later release adds never break code typed with it (`YCollabConfig`, the resolved configuration, names every option and grows with them)
