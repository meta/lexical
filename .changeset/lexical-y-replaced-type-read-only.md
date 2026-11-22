---
'@lexical/y': patch
---

[fix] A stored line that a node replacement builds as a class that cannot be stored as a line (a container class replacing a quote stored as a line) opens the document read only with `STORAGE_MISMATCH_WARNING` naming the type built, instead of showing edits to it that were never written

Verify: An editor that registers `{replace: X, with, withKlass}` whose `with` returns a class that cannot be stored as a line (`describeStorage`), over a document that stores `X` as a line, now binds it read only (`YCollabStatus` problem `storage-mismatch` with `replacement`), and `editYState` and `readYState` refuse it. This includes a replacement written the classic way (static `getType`, `clone`, `importJSON` and a hand-written `exportJSON`, such as a `CustomParagraphNode` replacing `ParagraphNode`), which is stored as a nested node: over a document that stores paragraphs as lines it now opens read only, where it used to write each line it edited as a nested node (two clients doing so at once wrote the content twice). Replacements stored the same way, and those of a format, a group or a nested node, are unaffected. Migrate the stored content before shipping such a replacement: reseed it from its JSON and bump `schemaVersion`.
