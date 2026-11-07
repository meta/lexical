---
'@lexical/eslint-plugin': patch
'@lexical/list': patch
'@lexical/react': patch
'@lexical/y': patch
---

[feature] Warn about accidental nested editor updates in the default ESLint presets

The new `@lexical/no-nested-editor-updates` rule identifies same-editor
nested updates and explains how to preserve update options, move updates
out of read callbacks, and clarify `$function` context ownership. Async
functions are left alone because their editor context may end at an `await`.
Both rules preserve the existing ESLint 8 source-code access fallback.

Checklist space-key handlers and collaboration initial-state callbacks use
their surrounding update context. Intentional nested updates and
cross-editor verification receive targeted lint exemptions.

Verify: Review new lint warnings in command and transform callbacks, check
transform preconditions when removing an update wrapper, confirm updates
after `await` are left alone, and verify checklist toggling and collaboration
initialization and undo behavior.
