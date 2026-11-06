---
'lexical': patch
---

[fix] Keep the deprecated unchecked node type arguments in the Flow declarations

v0.53.0 removed the unchecked type-argument overloads of `getParent`,
`getParentOrThrow`, `getParents`, `getPreviousSibling`, `getPreviousSiblings`,
`getNextSibling`, `getNextSiblings`, `getChildren`, `getFirstChild`,
`getFirstChildOrThrow`, `getLastChild`, `getLastChildOrThrow`,
`getChildAtIndex`, `getFirstDescendant`, `getLastDescendant`,
`getDescendantByIndex`, `$getNodeByKey` and `$getNodeByKeyOrThrow` from the
TypeScript declarations and from the hand-maintained Flow declarations in the
same release. TypeScript had shown them as `@deprecated` for several releases
before that; Flow has no deprecation signal, so a Flow codebase saw no warning
at all and every call site that passes a type argument stopped checking at
once, with `nonpolymorphic-type-arg` and the `prop-missing` errors that follow
it.

The overloads are back in the Flow declarations only, still `@deprecated` and
still unchecked casts. TypeScript is unchanged: it has no such overloads, and
new code in either language should call these methods without a type argument
and narrow the result with a node guard, as
[Narrowing traversal results](https://lexical.dev/docs/concepts/traversals#narrowing-traversal-results)
describes.

Removal: not scheduled; it needs the remaining Flow call sites to be migrated
first.
