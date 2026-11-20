---
'@lexical/y': patch
---

[fix] In development builds, the `@y/y` contract check no longer throws `YUnsupportedYjsError` for a `@y/y` that fixes the encoding problem `@lexical/y`'s loaders work around (yjs/yjs#824): it detects the fix, logs a warning that this `@y/y` appears to have it, and lets the binding run, as production builds already did

Verify: production builds are unchanged. With the supported `@y/y` 14.0.0-rc.29, development builds behave as before.
