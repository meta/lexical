---
'@lexical/y': patch
---

[feature] Warning and migration error codes are open (experimental): `YWarning` without a code is any warning of the binding's, its `data` unknown until `isYWarning(value, code)` narrows it to `YWarning<code>`; `YWarningCode` and `YMigrationErrorCode` accept codes a later version adds (`YKnownWarningCode`, `YKnownMigrationErrorCode` list this version's; Flow: `string`), and every code's `data` may be `{reason: 'other', detailCode, details?}`, a permanent fallback for conditions a later version reports., so code written today keeps compiling and working when they grow
