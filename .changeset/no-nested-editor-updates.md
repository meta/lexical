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
Both rules preserve the existing ESLint 8 source-code access fallback, and
the new rule resolves receiver bindings through the scope manager when
`SourceCode#getScope` is unavailable (before ESLint 8.37). `$function`
diagnostics condition wrapper removal and option migration on targeting
the active editor. Transform diagnostics link to the preconditions needed
for inline mutations to converge.

Checklist space-key handlers and collaboration initial-state callbacks use
their surrounding update context. Intentional nested updates and
cross-editor verification receive targeted lint exemptions.

Verify: Review new lint warnings in command and transform callbacks, check
transform preconditions and `$function` editor ownership when removing an
update wrapper, confirm updates after `await` are left alone, and verify
checklist toggling and collaboration initialization and undo behavior.
