---
'@lexical/y': patch
---

[fix] `migrateYState` no longer throws `RangeError: Maximum call stack size exceeded` on a document whose root (or any container) holds more than about 122,000 characters and line markers, and a step that throws is reported as a `YMigrationError` whose `cause` is the error it threw

Verify: migrate a layout 1 document with more than 130,000 characters of top-level paragraph text with `migrateYState(state, [step1to2, step2to3])`; it migrates to layout 3 and reads the same paragraphs.
