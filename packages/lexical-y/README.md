# `@lexical/y`

**Experimental.** A collaboration binding for [Lexical](https://lexical.dev)
on [Yjs 14](https://github.com/yjs/yjs) (`@y/y`). It is separate from
`@lexical/yjs` (Yjs 13): the two use different Yjs libraries and document
layouts, and a document uses one or the other. Every export is
`@experimental`, and `@y/y` is a release candidate.

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

```ts
import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {createYDoc, YCollabExtension} from '@lexical/y';
import {configExtension, defineExtension} from 'lexical';

// Yjs's format cleanup off (createYDoc(stored) for a stored state): the
// binding takes no other document.
const doc = createYDoc();
const editor = buildEditorFromExtensions(
  defineExtension({
    dependencies: [
      RichTextExtension,
      // Required: your app's document schema version, bumped whenever a
      // node's stored fields or node types change.
      configExtension(YCollabExtension, {doc, schemaVersion: 1}),
    ],
    name: 'app',
  }),
);
const {binding} = getExtensionDependencyFromEditor(
  editor,
  YCollabExtension,
).output;
// Connect `doc` to any Yjs 14 provider, then after its first sync:
binding.initialize();
```

## Documentation

- [Yjs 14 (`@lexical/y`)](https://lexical.dev/docs/collaboration/y): setup,
  options, servers, limits and upgrading from `@lexical/yjs`.
- [Server-side editing](https://lexical.dev/docs/collaboration/y-server):
  `@lexical/y/headless` (`seedYState`, `editYState`, `readYState`,
  `createYWriter` for who the server's edits are by, and `createYDoc` for a
  relay's copy of a document).
- [API reference](https://lexical.dev/docs/api/modules/lexical_y)

## Servers

A server or relay that loads a document into a plain Yjs `Doc` and stores
its state must set `doc.cleanupFormatting = false` before it applies
updates (`createYDoc(state)`, from `@lexical/y` or `@lexical/y/headless`,
makes such a document, as the clients do). Otherwise Yjs's format cleanup
deletes format items the clients keep, and the stored state reads
differently from what the clients show. See
[Servers](https://lexical.dev/docs/collaboration/y#servers) for the other
requirements (yrs versions, 32-bit client ids).

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

## Wire format: layout 1

Layout 1 is frozen: these names are stored in documents and do not change.
A change to any of them is a new layout version, which older clients open
read only. Layout 2 (below) keeps everything here and adds member entries
of set-valued NodeState; layout 3 (planned, #9449) adds move records.

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
  stored shape is read is a new version.
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

## Wire format: layout 2

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
