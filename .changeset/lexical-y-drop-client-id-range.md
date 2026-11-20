---
'@lexical/y': minor
---

[breaking] Remove `clientIDRange` and the `ClientIDRange` type: every client id is a 53-bit Yjs 14 id, so servers on yrs (y-crdt) need yrs 0.28 or later

`clientIDRange: 'uint32'` kept a document's client ids in 32 bits for servers on yrs before 0.28. The option is gone from `YBindingOptions`, `YCollabExtension`'s config, the `@lexical/y/headless` config, `prepareYRoom` and `migrateYState`, along with the writer's `'range'` reason of `WRITER_NEW_CLIENT_ID_WARNING`. Ids derived from content and the migration's client ids are unchanged under the default `'uint53'`.

Migration: delete `clientIDRange` from every config and options object, and the `ClientIDRange` import. A server on yrs before 0.28 upgrades to yrs 0.28 or later first: it reads 53-bit client ids, which earlier versions truncate (an author's content comes back duplicated on reconnect).

Detect: `clientIDRange` or `ClientIDRange` in your code; a `'range'` case on a writer warning's `data.reason`; a yrs (y-crdt, ywasm) dependency below 0.28 on a relay or server.
