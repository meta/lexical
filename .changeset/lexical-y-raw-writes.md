---
'@lexical/y': patch
---

[feature] The Yjs content under the binding's root (the root, its `lexical-y*` record keys, and every node, marker, format and state key below it) is private and unsupported for direct writes: change a document through the editor, `editYState` or a migration step. In development builds the binding reports a local transaction of another origin that changes it with `RAW_YJS_WRITE_WARNING` (`{reason: 'raw-write', root, kind, key, origin}`, once per binding and origin); production builds carry no check
