---
'@lexical/y': patch
'lexical': patch
'@lexical/list': patch
'@lexical/extension': patch
---

[feature] Add `@lexical/y`, an experimental collaboration binding for Yjs 14 (`@y/y`) that keeps concurrent typing through block splits, joins, retypes and link changes

Also new, for packages built on Lexical: `LexicalWarning` and the
`DEFER_COMPOSITION_MERGE_TAG` update tag in `lexical`, and the
`repairTransforms` option of `BlockIdExtension` in `@lexical/extension`
(default `true`, unchanged behavior). In `@lexical/list`, outdenting the only
or a middle item of a list item that wraps a nested list now keeps what that
item holds beside the nested list instead of deleting it.
