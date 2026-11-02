# `@lexical/mark`

[![See API Documentation](https://lexical.dev/img/see-api-documentation.svg)](https://lexical.dev/docs/api/modules/lexical_mark)

This package contains helpers and nodes for wrapping content in marks for Lexical.

It offers two ways to mark text, such as the ranges comments are on:

- **`MarkStateExtension`** (experimental) stores mark ids as NodeState on
  the text itself, with no wrapper node: `$addMarkID`, `$removeMarkID`,
  `$getMarkIDsAtSelection` and `$getNodeMarkIDs`. Its `isMarkIDShown` option
  chooses which ids are rendered (to hide resolved threads, for example),
  and `registerMarkIDsListener` reports the ids that appear in or disappear
  from the document. `defineMarkExtension` makes one such extension per
  kind of annotation (comments, suggestions, highlights), each on its own
  NodeState key: a _mark flavor_, which the `$` functions take as an
  optional first argument. Prefer it in collaborative editors: with
  `@lexical/y`, concurrent changes to different ids on the same text merge.
- **`MarkNode`** wraps the marked text in an element node
  (`$wrapSelectionInMarkNode`, `$unwrapMarkNode`, `$getMarkIDs`).

See [Comments and Annotations](https://lexical.dev/docs/collaboration/comments)
for usage, moving from `MarkNode`, resolving comments and limits.
