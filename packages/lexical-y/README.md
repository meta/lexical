# `@lexical/y`

**Experimental.** A collaboration binding for [Lexical](https://lexical.dev)
on [Yjs 14](https://github.com/yjs/yjs) (`@y/y`). It is separate from
`@lexical/yjs` (Yjs 13): the two use different Yjs libraries and document
layouts, and a document uses one or the other. Entries: `@lexical/y`,
`@lexical/y/headless`, `@lexical/y/migrate` (with a step per layout,
`@lexical/y/migrate/<n>to<n+1>`), `@lexical/y/offline` and
`@lexical/y/server`. Every export is
`@experimental`, and `@y/y` is a release candidate. `@experimental` is not
an exception to API compatibility: once released, the public API and its types
change only additively. No export is removed or renamed, and no published
migration step or revision is removed or changes what it writes. Each layout
below stays frozen once released, but while the package is experimental a
release may stop reading an older one, and rooms stored in it then open read
only until their server migrates them (see
[Layout upgrades](https://lexical.dev/docs/collaboration/y#layout-upgrades)).

## Start here

1. `const doc = createYDoc()`: the shared document, for your provider.
2. `yCollab({doc, schemaVersion, synced, onStatus})` in the editor's
   `dependencies` (`createYBinding(editor, {...})` for an editor built
   without extensions).
3. Connect your provider, sending `collab.handshake(generation)` before any
   sync message.
4. `collab.markSynced()` after its first sync.
5. `collab.freeze()` when the server says the room moved on (a stale
   generation): store what it returns before any reload.

```ts
import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  createYDoc,
  Y_DEFAULTS,
  yCollab,
  YCollabExtension,
  type YStatus,
} from '@lexical/y';
import {defineExtension} from 'lexical';

// Bump it when you add, remove or change a node class or its fields.
const SCHEMA_VERSION = 1;
const showStatus = (status: YStatus) => {
  // Tell the user when the document is read only, and why (status.cause).
};

const doc = createYDoc();
const editor = buildEditorFromExtensions(
  defineExtension({
    dependencies: [
      RichTextExtension,
      yCollab({
        doc,
        history: Y_DEFAULTS.history, // the default
        onStatus: status => showStatus(status),
        root: Y_DEFAULTS.root, // the default
        schemaVersion: SCHEMA_VERSION,
        synced: false, // markSynced() after the provider's first sync
      }),
    ],
    name: 'app',
  }),
);
const {collab} = getExtensionDependencyFromEditor(
  editor,
  YCollabExtension,
).output;
// Connect `doc` to a Yjs 14 provider, sending collab.handshake(generation)
// (null for a client with no local state) first; then, after its first sync:
collab.markSynced();
```

## Install

```sh
npm i --save-exact @lexical/y@nightly @lexical/extension@nightly \
  @lexical/rich-text@nightly lexical@nightly @y/y@14.0.0-rc.29
```

`@y/y` is a peer dependency pinned to the one release candidate this package
supports: install exactly that version, once. The peer dependency enforces
the version (`@y/y` exposes none at run time); at run time `createYDoc`,
`YBinding` and the headless helpers throw a `YUnsupportedYjsError`
(`data.supported` names the version) when the `@y/y` the app loaded lacks
what the binding uses, or the document comes from a second copy. A release
candidate older than `14.0.0-rc.25` (npm's `latest` among them) fails
earlier, at build or load, with a missing `Node` export. `@y/y`'s type
declarations do not
type-check on their own (an upstream issue): projects that run `tsc` need
`skipLibCheck: true`.

Until a Lexical release includes `@lexical/y`, npm's `latest` for it is a
placeholder: install every Lexical package from the same nightly, in one
command, as above; once a release includes it, install that release instead.
Name the version of the `@y/*` packages you add too: the `latest` tags of
`@y/websocket` and `@y/protocols` are builds for the earlier `yjs@14.0.0-*`
prereleases, so npm installs a second copy of Yjs next to `@y/y`. Use the
release candidates that peer on `@y/y` (`@y/websocket@4.0.0-rc.2`,
`@y/protocols@1.0.6-rc.1`). The published `@y/websocket-server` does not fit
as a relay either (see
[Servers](https://lexical.dev/docs/collaboration/y#servers)).

## Usage

See [Start here](#start-here). The earlier setup (`createYCollabConfig`,
`binding.initialize()`) keeps working; [the guide](https://lexical.dev/docs/collaboration/y)
covers both.

## Documentation

- [Yjs 14 (`@lexical/y`)](https://lexical.dev/docs/collaboration/y): setup,
  options, servers, limits and upgrading from `@lexical/yjs`.
- [Server-side editing](https://lexical.dev/docs/collaboration/y-server):
  `@lexical/y/headless` (`seedYState`, `editYState`, `readYState`,
  `createYWriter` for who the server's edits are by, and `createYDoc` for a
  relay's copy of a document), and migrating stored documents
  (`@lexical/y/server`).
- [Offline](https://lexical.dev/docs/collaboration/y#offline-local-persistence-and-edits-that-did-not-sync)
  (EXPERIMENTAL): `@lexical/y/offline`, a local store for Yjs 14 documents
  on IndexedDB (`openYOfflineStore`) and the offline session
  (`attachYOfflineSession`, `recoverYOfflineEdits`, `replayUnsyncedEdits`)
  with its rollout stages `'off'`, `'persist'` and `'replay'`.
- Layout migrations (EXPERIMENTAL): `@lexical/y/migrate` (the runner) and
  one frozen step per layout (`@lexical/y/migrate/1to2`); see
  [Changing the layout and migrating](https://lexical.dev/docs/collaboration/y#changing-the-layout-and-migrating).
- [API reference](https://lexical.dev/docs/api/modules/lexical_y)

## Servers

A server or relay that holds a document in a Yjs `Doc` (to apply updates
to it, store, compact or merge it) creates it with `createYDoc(state)` from
`@lexical/y/server` (Yjs only, no Lexical import); the package has no relay
of its own. A relay that cannot import it sets
`doc.cleanupFormatting = false` on a new `Doc` before it applies updates.
Otherwise Yjs's format cleanup deletes format items the clients keep, and
the stored state reads differently from what the clients show. It is also
slow with paired runs: loading a 20,000-word document takes about 150 ms with the
cleanup on, against 19 ms with it off. See
[Servers](https://lexical.dev/docs/collaboration/y#servers) for the other
requirements (yrs 0.28 or later).

## Running the long fuzz

The randomized suites in `src/__tests__/unit` run a few seeds in CI; set
these to run more (from the repository root, with
`npx vitest --project unit --no-watch packages/lexical-y`):

- `FUZZ_SEEDS`, `FUZZ_GC_SEEDS` (`Fuzz.test.ts`, with and without
  garbage collection; `FUZZ_SEED_START` picks the first seed);
- `NORMALIZE_FUZZ_SEEDS` (`NormalizationConvergence.test.ts`);
- `SHAPE_FUZZ_SEEDS` (`ConcurrentShapesFuzz.test.ts`);
- `SLOTS_FUZZ_SEEDS` (`SlotsFuzz.test.ts`, named slots);
- `STORAGE_FUZZ_SEEDS`, `STORAGE_PROP_SEEDS` (`DerivedStorage.test.ts`);
- `LEXICAL_Y_BLOCK_ID=1` builds the editors of `Fuzz.test.ts`,
  `Races.test.ts`, `NormalizationConvergence.test.ts` and the other suites
  on the shared test helpers from `YCollabExtension` and
  `BlockIdExtension`, as an app that uses both does.

To replay one seed with its trace: `FUZZ_SEED=<seed>` (add `FUZZ_GC=1` for
the garbage-collected run), `NORMALIZE_FUZZ_TRACE=<seed>` or
`STORAGE_FUZZ_TRACE=<seed>`.

## Bumping `@y/y`

The binding writes through Yjs internals, so a new `@y/y` is a deliberate
change, never a range:

1. Set the exact version in both `peerDependencies` and `devDependencies`,
   and in the playground's own `@y/y` pin
   (`packages/lexical-playground/package.json`; nothing in the workspace ties
   it to this one, and a playground on the old version would load two copies
   of Yjs), then run `pnpm install` and `pnpm run update-version` (which
   regenerates `SUPPORTED_YJS_VERSION` in `src/internal/SupportedYjs.ts`).
2. Run `YjsContract.test.ts`: update the exports, members and events in
   `src/internal/YjsContract.ts` to what the binding uses of the new
   version, and re-check each changed one in the code that uses it.
3. Run the equivalence test (`Cursor.test.ts`, the binding's cursor against
   `Y.Node#applyDelta`), the catalog matrix (`src/__tests__/unit/matrix`)
   and the long fuzz above, then update the version in the install
   commands here and in the docs (`docs/collaboration/y.md`).

## Storage

The shared root is `doc.get('lexical-y')` (`DEFAULT_ROOT_NAME`). How an
element type is stored is derived from the node structure its class
declares in `$config()`, first match wins: a block with `children: 'inline'`
is a `line`; an inline element with `mergeAdjacent` is a `format`; a block
that lists only line classes as `children`, with `mergeAdjacent`, is a
`group` (a list); anything else is `nested`. The first three also need the
class's data to be fully in its schema and NodeState, and no declared
`slots` (a node stored as its own `Y.Node` stores its slots, see below).
`describeStorage(editor)` returns the result per type. The first write of a
type records its kind on the root (`k:<type>`); a later client whose class
derives another kind uses the recorded one when it can, and opens read only
otherwise.

## Wire format

**Private: read it, never write it.** The Yjs content under the binding's
root is the binding's private encoding: the root itself, its record keys
(`lexical-y:<n>`, `lexical-y-schema:<n>`, `lexical-y-epoch`,
`lexical-y-require:<feature>` and every other `lexical-y-*` key), and every
node, marker, format and state key below it. It is specified here for
readers (servers, tools that inspect stored documents), not for writers.
Direct Yjs writes under the root are unsupported: change a document through
the editor, `editYState` or a migration step. Development builds report a
local transaction of another origin that changes it
(`RAW_YJS_WRITE_WARNING`).

Each layout adds to the one before and is frozen once released: layout 1
is the base, layout 2 adds member entries of set-valued NodeState, layout 3
stores format runs as paired runs, and layout 4 stores flat NodeState on
text as paired runs too. This release writes layout 4 (`MIN_LAYOUT` and
`LAYOUT_VERSION`); a document that records only an older layout opens read
only until its migration (see [layout 4](#wire-format-layout-4)).

### Wire format: layout 1

Layout 1 is frozen: these names are stored in documents and do not change.
A change to any of them is a new layout version, which older clients open
read only. Move records (#9449) need a later layout.

- **Root:** the top-level type `lexical-y` (or the `root` option). Root
  attributes: `lexical-y:<n>` = `true` for each layout version `n` the
  document needs (`lexical-y:1` here), and `k:<type>` = the storage kind
  recorded for each element type on its first write: `line`, `nested`,
  `group|<field>,…` or `format|<field>,…` (the group's or format's identity
  fields).
- **Schema record.** Root attributes `lexical-y-schema:<n>` = `true`, one
  for each version `n` of the app's own schema (`schemaVersion`) that wrote
  to the document. A client records its version in the same transaction as
  its first write to the document (a new document's with its layout
  record), so no client receives that write without it; opening a document
  records nothing (an update an app makes on open is a write). A reader takes the highest, and opens the document read
  only when it is higher than its own `schemaVersion`, or when a
  `lexical-y-schema:` attribute is not an integer from 1 set to `true`. Like
  the layout record, it only grows: no client deletes one, and undo keeps
  it. It is not part of the layout: a reader that ignores it reads the rest
  as before.
- **Layout record.** A reader takes the highest `lexical-y:<n>`, and opens
  the document read only when it is newer than its own layout, or when a
  `lexical-y:` attribute is not an integer from 1 set to `true`. The record
  only grows: no client deletes one, and a writer records a version in the
  same transaction as the first content that needs it (a new document
  records version 1 before its content), so no client receives that content
  without the version. Two clients that upgrade a document at once both
  record theirs, and every reader takes the higher. Any change to how a
  stored shape is read is a new version. A reader also opens the document
  read only when the version is older than `MIN_LAYOUT`, the oldest it
  reads, until a migration (`@lexical/y/migrate`) moves it up.
- **Epoch.** The root attribute `lexical-y-epoch` = `{v: 1, kind, layout,
  client, clock, step, revision, schema?}`, written by a migration in the
  same transaction as what it changes. `layout` is the destination (the
  root's layout after it, from 1); `step` and `revision` are the receipt
  (which frozen step, at which immutable revision, wrote it: an opaque,
  namespaced id such as `lexical-y/layout/<n>to<n+1>`); `(client, clock)`
  is the id of the transition's first newly written item (for a layout
  migration, its layout record), the transition identity the generation
  uses; `kind` is the family (`'layout'`, the only one this release
  writes; a missing kind reads as `'layout'`); and `schema`, when present,
  is `{id, version}` of an app schema. Readers accept fields they do
  not know and leave them in place. It is outside the `lexical-y:`
  namespace, so older releases ignore it; this release opens a document
  whose epoch has another `v`, or a known field that is not well formed,
  read only (an absent epoch is fine). Each migration replaces it. Servers derive a document's
  generation from its `(client, clock)` (`getYGeneration` in
  `@lexical/y/server`, a versioned algorithm); a client never adopts a
  generation from it.
- **Feature requirements.** Root attributes `lexical-y-require:<feature>` =
  `true`, grow-only, the feature id an opaque string, written before (or
  with) the content that needs the feature. A reader that does not support
  every required feature, or finds a requirement that is not well formed
  (an empty id, a value other than `true`), opens the root read only: it
  shows it, keeps it and never rewrites it (`UNSUPPORTED_LAYOUT_WARNING`,
  `'requires'` or `'malformed'`). The migration runner refuses to migrate
  such a root (`YMigrationError` `'unsupported-feature'` or `'malformed'`,
  before any root runs); a root that needs no step passes through
  unchanged. This release supports no feature. Any other `lexical-y-*`
  attribute a reader does not know is kept and ignored. Releases before
  this one read only `lexical-y:<n>` and ignore `lexical-y-require:*`, so
  they would still edit such a root: a writer that adds a requirement also
  raises the layout record (older releases then open the root read only),
  or relies on its server's fence to keep those clients out.
  A server lists every required feature in `describeYRoom`'s `requires` and
  admits no session that does not present them all; a malformed requirement
  makes its root unreadable.
- **Children of a container** (the root and every node stored as its own
  `Y.Node`), in order:
  - text (`Y` strings) with formats;
  - `¶` (U+00B6) nodes: line markers. A line is the inline content before its
    marker. Inline content that no marker ends (concurrent edits can leave
    some: text typed into a line a collaborator removed) reads as a
    paragraph, or in a container that is a group itself as an item of the
    group, with no attributes; where the editor has `BlockIdExtension`, its
    block id is `y`, the client of its first character's item, `_` and that
    item's clock (both in base 36);
  - `¦` (U+00A6) nodes: run terminators, ending inline content that belongs
    to the container itself;
  - `b:<type>` nodes: blocks stored as nodes (a unit of the container);
  - `i:<type>` nodes: nodes inside inline content.
- **Container attribute:** `c` = `'b'` (holds blocks) or `'i'` (holds inline
  content), fixed when the node is created.
- **Named slots** (`$setSlot`): a node stored as its own `Y.Node` (`b:<type>`
  or `i:<type>`) holds each of its named slots as the attribute
  `slot:<name>`, whose value is the slot's node: a `b:<type>` `Y.Node`
  stored like any block stored as a node (its attributes, `c`, its children
  and its own slots). A reader gives the node a slot `<name>` per such
  attribute, and opens the document read only when one holds anything but
  a `b:` node of a registered block type. Lines, formats, groups and the
  root have no `Y.Node` of their own and hold no slots: a writer refuses
  such a slot (warning `@lexical/y/unsupported-slots`, read only).
- **Node and marker attributes:** `t` = the type (on a marker, left out for a
  paragraph; on a stored node, only when it was replaced in place by another
  type), `p:<field>` = a schema field, `s:<key>` = a NodeState value.
- **Group items** (markers of a group's items, such as list items): `g` = the
  group type, `g:<field>` = the group's identity fields, `l` = the level
  (0 for top level), `o` = for a nested item, the identity fields of each
  outer level, outermost first, with `@` holding the fields of a level's
  wrapper item.
- **Text formats:** `t` = the text node type (left out for `text`),
  `f:<format>` = `true` per text format, `p:<field>`, `s:<key>`, `k` = a
  segment key that keeps text nodes Lexical would not merge apart, and
  `w:<type>` = a format wrapper (an inline element stored as a format, such
  as a link), whose value is an object of its fields and NodeState, with `#`
  telling apart two adjacent wrappers with equal fields.
- **Line breaks** are the character `\n` in the text, with their NodeState
  as text formats (`s:<key>`).
- **Values:** primitives are stored as they are. Other JSON values (objects
  and arrays) are stored three ways, by where they sit:
  - in node and marker attributes (`p:`, `s:`, `g:`, `o`): the JSON value
    itself;
  - in text formats (`p:`, `s:` on text and on a line break): an object
    `{json: '<JSON>'}`, the value's JSON with sorted keys as a string (Yjs
    compares format values one level deep);
  - as a member of a format wrapper's value (`w:<type>`): the string
    `\u0000` followed by the value's JSON with sorted keys. A string that
    itself starts with `\u0000` is stored the same way (as the JSON of that
    string), so every member reads back with its type and value.
- **Names a client does not own:** a writer changes the value a name gives
  content only for the names it owns, the binding's own and the fields its
  classes declare for the content's type (all of them where the write
  changes that type; on a node stored as its own Y.Node and on text, its
  flat NodeState too), its text formats and NodeState, and keeps every other
  name's value as stored: a field a newer version of a class added, a text
  format a newer Lexical added, a key of a later layout. Format items that
  only keep every name's value where it is (around inserted content, at the
  end of a run) carry any name. Inserted text takes the names it does not
  own from the text it continues (a field only from text of its own type).
  A marker or shared node written anew for a node stored before (a block
  moved, a line split) takes the fields the old one stored that the writer
  does not own. A group item new to its group, or written anew, takes the
  group fields of the item next to it that kept its marker and was in the
  group before; where none did, those the group stored before the write (on
  the item's old marker, another item's, or that of an item the group had
  then). An outer level takes the fields of its item (`@`) from where that
  item's were stored. A reader reads only the names it owns.
- **Defaults are left out:** a field or NodeState value equal to the one a
  new instance of the class has (its `$config` default) is not stored, so a
  reader takes it from its own class (an `h1` heading's marker is
  `{t: 'heading'}`; a nested item of a numbered list has no `g:listType`).
  Every client of a document must therefore register classes with the same
  defaults.

### Wire format: layout 2

Layout 2 is layout 1 plus member entries of set-valued NodeState, and is
frozen the same way.

A layout 1 document is upgraded in place, lazily. The first client that
writes a member entry adds `lexical-y:2` = `true` to the layout record, in
the same transaction; undo never deletes it. Nothing else is rewritten.
From then on, clients that only read layout 1 open the document read only
(they would read the entries as other NodeState and miss the members).
Documents that never hold a member entry stay at layout 1, and older
clients keep editing them.

- **Set-valued NodeState** (an `arraySetValue` state, whose schema has
  `meta.kind === 'set'`): on text, line breaks and nodes stored as their
  own `Y.Node`, one `s:<key>\u001f<member>` = `true` entry per member
  instead of one `s:<key>` value (`s:\u001f<member>` for a state whose key
  is empty). Yjs stores names as UTF-8, which would turn a lone surrogate
  into U+FFFD, so a member holding one, or starting with U+001F, is
  escaped: its entry is `s:<key>\u001f\u001f` followed by the member's
  JSON, with every surrogate code unit written as a `\uXXXX` escape. A
  reader joins the entries back into one array, unless it knows a state of
  the entry's own name, or a state of the set's key that is not a set. For
  a state it does not know yet, the array is an unknown NodeState value,
  which the state's first use reads, and which is written back one entry
  per member, as is any array under that key on a node of that type (a
  JSON copy of the node's state too): an unchanged set writes nothing, and
  a changed one writes only the members it adds or removes. A whole
  `s:<key>` array (layout 1) next to member entries is joined with them,
  and the next write stores it per member. A set whose key contains U+001F
  is stored as one value. Any other StateConfig whose key starts with a
  set-valued state's key and U+001F would be the name of a member entry, so
  the binding refuses it whenever it writes it or the set, even without a
  value (an invariant in development; in production a warning, and the set
  is stored as one value).

### Wire format: layout 3

Layout 3 is layout 2 with paired format runs, and is frozen the same way.
The release that wrote it recorded `lexical-y:1` and `lexical-y:3` (and
`lexical-y:2` when the document held a member entry) with a new document's
first content. The frozen step `@lexical/y/migrate/2to3` (after `1to2` for
layout 1) rewrites the format runs of an older document, in place, keeping
every content id. This release reads layout 3 only to show it (see
[layout 4](#wire-format-layout-4)).

- **Covered names.** The names whose runs are paired, by stored name: `t`
  and `k` (a text node's type and segment key), `f:<format>`, `p:<field>`
  on text, `w:<type>` (links and other inline elements stored as a format),
  and `s:<key>\u001f<member>` (member entries of set-valued NodeState).
  Every other name keeps layout 2's plain-value rules: a flat NodeState
  value `s:<key>` (apps change it through the editor's NodeState APIs; raw
  Yjs writes under the root, `s:<key>` included, are unsupported, D109),
  and any name the binding does not write.
- **Runs.** A write's run of a covered name is an opener and an end:
  - the **opener** is a format item whose value is the run's value, or `[]`
    for a run that shows no value (text made plain inside another run);
  - the **end** is a format item of the same name, later in the same
    container, whose value names the opener: `[d]` for the item `d` clocks
    before the end on the end's own client (`d` a positive integer), or
    `[client, clock]` (non-negative integers) for an opener of another
    client. A plain `null` keeps its meaning.
- **Reading.** A reader keeps, per covered name, a stack of open runs while
  it walks a container. A live opener that a live end names is paired: it
  pushes its run. Any other item of the name (a plain value, a plain
  `null`, an opener whose end is deleted or has not arrived) is unpaired:
  it replaces the unpaired runs above the topmost paired run and pushes
  itself. A live end removes the run it names, with the unpaired runs above
  it; the paired runs above it stay. An end whose run is not open (it names
  an item that is not an opener of its name in its container, or one after
  it) removes the unpaired runs above the topmost paired run, as a `null`
  would. So does an array of any other shape, which names nothing: every
  array but `[]`, `[d]` and `[client, clock]` (another length, an element
  that is not such an integer, a nested array). These shapes are reserved:
  a raw writer's array, or an end a later layout adds, is never shown as a
  value, and the binding never rewrites, re-points or deletes one. Every
  value that is not an array is a value, an object keyed by array indices
  (a wrapper whose class declares a field named `0` stores one) and a typed
  array included. The top run's value is the one shown. A container
  without ends reads exactly as with plain values. Format names whose first
  character is U+0002 are not read.
- **Whole containers.** A migration step and seeding write each container
  in one canonical form: the countable units split into maximal stretches
  whose covered values are all equal; each stretch gets an opener for each
  covered name it holds, in name order, right before its first unit, and the
  matching ends, in the same order, right after its last unit, each `[d]`. A
  value that is not JSON-representable is refused before anything is
  written; a raw array is stored as `{json: <its JSON>}` so it cannot read
  as an end. Seeding writes these runs interleaved with the content, in the
  seed's own pass; the seed's bytes are pinned per `SEED_LAYOUT`, so a
  change to them is a new seed layout.
- **Copies.** An undo or redo restores a deleted end as a new item that
  shares its value with the original, and a raw writer's `format()` can copy
  a stored end. In documents made by `createYDoc`, such a copy is given
  its own value, naming the opener the original named (or that opener's own
  restored copy), before the transaction's update is encoded, so every peer
  receives a correct end. A copy of an end of a reserved shape (see Reading)
  keeps its value as it is.

### Wire format: layout 4

Layout 4 is layout 3 with one mechanism for every name the binding writes
on text, and is frozen the same way. It is the only layout this release
writes: `MIN_LAYOUT`, `LAYOUT_VERSION` and `SEED_LAYOUT` are 4. A new
document records only `lexical-y:4`, before its first content; a migrated
document keeps its earlier records and adds `lexical-y:4`. Nothing records
`lexical-y:2` any more (layout 4 includes member entries).

- **Covered names.** Layout 3's, and flat NodeState: `t`, `k`,
  `f:<format>`, `p:<field>`, `w:<type>` and every `s:` name, a flat value
  `s:<key>` as well as a member entry `s:<key>\u001f<member>`. A flat
  value is written as a paired run, read by the run stack, and removed with
  a `[]` run, exactly as a text format is: two collaborators' overlapping
  values nest, and a value's undo removes exactly its own run. Its value
  encoding does not change (a primitive as is, an object or an array as
  `{json}`).
- **Any other name** is not the binding's: it reads by the plain-value
  rules, and the binding never writes, changes or deletes an item of it.
  Text typed next to such an item takes the value the name has there.
- **Reading a layout 3 document.** A document that records layout 3 opens
  read only (`'older'`) and is shown by the same reader: its flat NodeState
  items have no ends, so they read as unpaired values, which is how layout
  3 read them. The one difference is an array a raw writer stored under a
  flat NodeState name (unsupported, D109): layout 3 read it as a value,
  and the read-only display reads it as an end that names nothing.
- **Migration.** The frozen step `@lexical/y/migrate/3to4` takes no
  parameters. Per container it reads each countable unit's values as
  layout 3 read them (flat NodeState by the plain fold), deletes every live
  format item of a covered name except reserved shapes, which stay where
  they are, and writes the values in the canonical whole-container form.
  Every content id is kept, and the document reads the same before and
  after. A run left dangling (an opener whose end is gone, an end naming
  nothing) is migrated by what it showed: a value that read as open to the
  end of its container becomes a paired run ending at the container's last
  unit. An array a raw writer stored under a flat NodeState name is stored
  as the value it showed (`{json}`). A container that holds no live item of
  a flat NodeState name and already meets layout 4's pairing invariant is
  left as it is (its bytes are kept): it reads the same under both layouts.

