---
'@lexical/mark': patch
---

[feature] Add mark flavors: `defineMarkExtension` makes one extension like `MarkStateExtension` per kind of annotation (comments, suggestions, highlights), each on its own NodeState key with its own rendering, config and output; the `$` mark functions take a flavor as an optional first argument, `registerMarkIDsListener` reports the ids that appear in or disappear from the document, and `MarkBaseExtension` is the shared base
