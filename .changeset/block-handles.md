---
'@lexical/extension': patch
'@lexical/html': patch
---

[feature] Block handles for showing blocks to a model: `$getBlockHandle(node)` gives a block a short opaque handle, the shortest prefix (at least 4 characters, like a short git hash) of a 64-bit hash of its id that no other block's hash starts with, so handles stay short and typo-safe whatever the ids look like, `$getBlockHandles()` gives every block's, and `$resolveBlockHandle(handle, {read})` finds the block again (with `read`, the handles the model was shown, the block it named in that read, while it exists), returning `found`, `not-found`, `ambiguous` (with the candidates' handles) or `invalid` (`too-short` or `malformed`) instead of throwing; `BlockIdHTMLExtension` takes a new `handles` option (default `false`) that, with `export` on, writes `data-block-handle` (`BLOCK_HANDLE_ATTRIBUTE`) instead of `data-block-id`

A handle costs about 3 to 4 o200k tokens where a 21-character id costs about 14. Handles are derived from the stored ids and never stored; ids, `$getBlockById`, the `export` option (still a `boolean`) and HTML import are unchanged, and import never reads `data-block-handle`.
