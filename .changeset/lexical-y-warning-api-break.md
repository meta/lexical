---
'@lexical/y': minor
---

[breaking] Freeze the warning API with open codes and explicit code guards, widen `LAYOUT_VERSION` to `number`, and make direct Yjs writes below the binding root unsupported

Existing code that relies on `YWarning` as a closed discriminated union, on exhaustive switches over `YWarningCode` or over the layout and config warning reasons, or on a literal layout-version type must change. What changed:

- `YWarningCode` is open (any string; Flow: `string`), and so is `YHeadlessWarningCode`, which includes it. The package exports no closed list of codes.
- `YWarning<C = string>` is generic: without a code its `data` is `unknown`. `isYWarning(value)` still checks for any binding warning, and `isYWarning(value, CODE)` narrows to `YWarning<CODE>`, whose `data` is that code's.
- `YWarningData<C>` adds `YOtherWarningData` (`{reason: 'other', detailCode, details?}`), a permanent fallback for conditions a later version reports under an existing code. For a code this version does not report it is `unknown`.
- `YUnsupportedLayoutData` adds the `'older'` (with `upgrade`) and `'requires'` reasons, and `YUnsupportedConfigData` adds `'missing-layout-upgrade'`.
- `LAYOUT_VERSION` (and `MIN_LAYOUT`, `SEED_LAYOUT`) are typed `number`, no longer the literal `2`. The value is unchanged.
- Flow: the Flow-only `YWarningOf` typing helper is no longer exported, and `YBindingOptions` and `YCollabConfig` are inexact (a later release may add optional fields).
- The Yjs content below the binding's root (the root, its `lexical-y*` record keys, every node, marker, format and state key) is private and unsupported for direct writes. Development builds report a local transaction of another origin that changes it with `RAW_YJS_WRITE_WARNING` (`{reason: 'raw-write', root, kind, key, origin}`, once per binding and origin). Production builds carry no check.

Migration: use `isYWarning(value, CODE)` before reading typed data, handle `reason: 'other'`, and keep a generic fallback for codes you do not know. For example, `if (isYWarning(value) && value.code === UNSUPPORTED_LAYOUT_WARNING && value.data.reason === 'newer')` becomes `if (isYWarning(value, UNSUPPORTED_LAYOUT_WARNING) && value.data.reason === 'newer')`. Use `number` for a layout value. In Flow, replace imports and uses of `YWarningOf` with `YWarning<CODE>` and handle the same `other` fallback; code that defines its own warning shape should use its own type. Configure new setups with `createYCollabConfig({doc, schemaVersion, layoutUpgrade})`, using `createYServerLayoutUpgrade()` or `null`; existing partial or complete `configExtension(YCollabExtension, ...)` configuration is still accepted. Replace direct writes to Lexical's Yjs encoding with editor or `editYState` operations, and keep other app data in separate roots.

Detect: compile existing warning handlers and look for unknown-data errors, failed exhaustive switches, or literal `LAYOUT_VERSION` assignments; in Flow, a missing `YWarningOf` export; in development, look for `RAW_YJS_WRITE_WARNING`.

Verify: compile the updated code-specific handlers, generic fallbacks included; exercise representative warnings and normal editor and headless edits; confirm that supported writes emit no raw-write warning and that documents below the floor behave as the declared `layoutUpgrade` says.
