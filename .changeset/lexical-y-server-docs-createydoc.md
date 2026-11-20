---
'@lexical/y': patch
---

[docs] Servers and relays that hold `@lexical/y` documents create them with `createYDoc` from `@lexical/y/server` (or set `doc.cleanupFormatting = false` on a plain `Doc`): with Yjs's default format cleanup, applying updates deletes format items the clients keep, and loading a 20,000-word layout-3 document takes about 150 ms against 19 ms
