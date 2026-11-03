---
'@lexical/y': minor
---

[breaking] Store format runs as paired runs (layout 3), and read and write layout 3 only: `MIN_LAYOUT`, `LAYOUT_VERSION` and `SEED_LAYOUT` are now 3

Each run of a text format, link, text field, text node type or comment id is now an opener and an end that names it, so concurrent formats of one key nest instead of cutting each other short, and a format's undo removes exactly its own run. Rooms stored at layout 1 or 2 open read only, showing their content, until they are migrated with `@lexical/y/migrate/2to3`, which keeps every character, node and line marker with its Yjs id and reads the same before and after. Older `@lexical/y` releases open a layout 3 room read only (`UNSUPPORTED_LAYOUT_WARNING`, reason `'newer'`). Code that writes formats straight into Yjs (`Y.Node#format`) still converges, but in a layout 3 room its plain items can change other text's formatting; write through an editor or `editYState` instead. A text class must decide which format bits it shows from its class, fields and NodeState only, not from its text, its editor or where it is attached.

Migration: upgrade every client of a room together. A server migrates each stored room when it loads it, before serving it, with `prepareYRoom` (`@lexical/y/server`) or `migrateYState` (`@lexical/y/migrate`), whose default steps now include `@lexical/y/migrate/2to3` (a step list of your own adds it after `@lexical/y/migrate/1to2`); keep the generation fence (`checkYSession`) on every relay, so clients still on an older release never receive a migrated room, and replace the incarnation of rooms not yet seeded (`needsNewIncarnation(room, SEED_LAYOUT)`), since the seed layout changed. Clear an app `UndoManager` at the migration with `onYMigrationEpoch(doc, fn, root?)`; one that is not cleared can restore formatting the migration replaced.

Detect: rooms whose root records `lexical-y:1` or `lexical-y:2` but not `lexical-y:3`; `UNSUPPORTED_LAYOUT_WARNING` with `reason: 'older'`; server step lists of your own without `@lexical/y/migrate/2to3`; code that calls `format()` or inserts with attributes on the `lexical-y` root's text.

Verify: open a stored layout 2 room after migrating it on the server: it is editable and reads as before; without the migration it opens read only and nothing is written.
