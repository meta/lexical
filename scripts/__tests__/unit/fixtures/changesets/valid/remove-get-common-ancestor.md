---
'lexical': minor
---

[breaking] Remove `LexicalNode.getCommonAncestor`
@contributor

Migration: use `$getCommonAncestor` from `lexical`.

```ts
// Before
const ancestor = a.getCommonAncestor(b);
// After
const ancestor = $getCommonAncestor(a, b)?.commonAncestor ?? null;
```

Detect: calls to `.getCommonAncestor(` on nodes.

Codemod: none; each call site needs review.
