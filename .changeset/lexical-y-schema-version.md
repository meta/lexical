---
'@lexical/y': patch
---

[feature] Open a document read only in a client older than the newest app version that wrote to it: `YCollabExtension`, `YBinding` and the `@lexical/y/headless` config take a required `schemaVersion`, and an older client reports `UNSUPPORTED_SCHEMA_WARNING`

Each client records its app's `schemaVersion` in the document with its
first write there (`lexical-y-schema:<n>` on the root, a record that only
grows and that undo keeps). A client whose `schemaVersion` is lower than
the highest recorded opens the document read only, on open or the moment a
newer client's write arrives, and reports `UNSUPPORTED_SCHEMA_WARNING` with
`{reason: 'newer', found, supported}`; an older `editYState` or
`readYState` refuses with a `'read-only'` `YHeadlessError` carrying it.
Clients of an equal or newer version edit as before, keeping the fields
they do not declare.

Verify: building `YCollabExtension` without `schemaVersion` throws with the
fix in its message; pass your app's schema version (start at 1, and bump it
whenever a node's stored fields or node types change) there, to `new
YBinding(editor, doc, {schemaVersion})`, and in every headless config. Code
that handles every `YWarningCode` handles the new one.
