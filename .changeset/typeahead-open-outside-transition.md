---
'@lexical/react': patch
---

[feature] `LexicalTypeaheadMenuPlugin` accepts `openInTransition` (default `true`). Set it to `false` to set the menu resolution, on open and on each query change, as a normal React update instead of inside `startTransition`, so a busy host no longer delays the menu for seconds after the trigger key
