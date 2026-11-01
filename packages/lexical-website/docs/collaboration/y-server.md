---
sidebar_position: 3
---

# Server-side editing with `@lexical/y`

:::warning Experimental

`@lexical/y` is experimental. Its document layout and these APIs may change
without a migration.

:::

`@lexical/y/headless` runs Lexical edits on a stored Yjs 14 (`@y/y`) state
on a server, without a DOM. It binds a headless editor with the same binding
as the clients, so what the server writes is what a client would have
written, and it merges with the clients' concurrent edits like any other
peer's. See [Yjs 14 (`@lexical/y`)](./y.md) for the binding itself.

```ts
import {
  createYWriter,
  editYState,
  readYState,
  seedYState,
} from '@lexical/y/headless';
import {
  $createParagraphNode,
  $createTextNode,
  $getEditor,
  $getRoot,
} from 'lexical';

// The clients' extensions: the server must register every node type the
// clients use (through `extensions` or `nodes`) and the extensions that
// change what is written, such as `BlockIdExtension`, so that it writes
// what a client would. `schemaVersion` is the version of the app's
// schema this server's code has, as on the clients (required).
const config = {extensions: [AppNodesExtension], schemaVersion: 3};

// Who the server's edits are by: one writer per agent or integration,
// created once per process (see Writers below).
const writer = createYWriter('Import service');

// A new document.
const state = seedYState(config, () => {
  $getRoot().append($createParagraphNode().append($createTextNode('Hello')));
});

// One edit on the stored state.
const {update, state: next} = editYState(
  state,
  config,
  () => {
    $getRoot().append($createParagraphNode().append($createTextNode('More')));
  },
  {writer},
);
// Send `update` to the connected clients and store `next` (one write at a
// time per document: see "One edit at a time per document" below).

// Read the document: its JSON, Markdown, plain text...
const json = readYState(next, config, () =>
  $getEditor().getEditorState().toJSON(),
);
```

## API

Each function takes a config with the editor's `extensions` (or `nodes`),
a required `schemaVersion` (the version of the app's schema this code has,
see [Versioning your schema](./y.md#versioning-your-schema)), and
optionally `root` (default `'lexical-y'`), `clientIDRange` (see
[Servers](./y.md#servers)), `onWarn` and `selfCheck`. `editYState` also
takes options with a required `writer` (see [Writers](#writers)).

A seed records its config's `schemaVersion`, and so does an edit that
writes. A document a newer version wrote to is read only for an older
server, as for an older client: `editYState` and `readYState` throw a
`YHeadlessError` (`'read-only'`) whose `warnings` hold the
`UNSUPPORTED_SCHEMA_WARNING`, and nothing is written. Deploy servers with
(or before) the clients whose version they serve.

| Function | Returns |
| --- | --- |
| `seedYState(config, $build)` | The state of a new document holding what `$build` writes. |
| `editYState(state, config, $edit, {writer, ...})` | `{update, state, warnings, clientID}` after one edit. |
| `readYState(state, config, $read)` | What `$read` returns. Nothing is written. |
| `createYWriter(author)` | A writer for `editYState`: who its edits are by. |
| `createYDoc(state?, options?)` | A `Y.Doc` for a relay or server that loads a stored state, with Yjs's format cleanup turned off as on the clients (the same function as `@lexical/y`'s, which clients bind). |

- **`seedYState`** creates a document's content outside a client: from a
  template, an import, or a converter. It writes as a client's
  `initialize()` writes its initial content, with a client id derived from
  the content, so seeding identical content twice (with the same
  `schemaVersion`) gives the same bytes and two seeds merge into one copy. Content with random parts (such as ids an
  extension draws for new blocks) is not identical: seed a document once.
  With `BlockIdExtension`, a seed and a client's initialization of the same
  content do not merge either, unless the content gives its blocks fixed
  ids: a client names the blocks of its initial content by position, and a
  seed names them with `generateId`.
- **`editYState`** runs `$edit` in one discrete update, then commits the
  updates it made listeners schedule (an extension giving new blocks ids),
  and returns the merged update of everything written, or `update: null`
  when nothing changed, `state` with the update merged in, and the
  `clientID` it wrote under. Options:
  - `writer` (required): a writer from `createYWriter`, or `null` for a new
    anonymous client id for this edit alone (see [Writers](#writers)).
  - `allowedRoots`: the shared roots the update may write to (default: the
    layout root). An update that writes anywhere else is refused. The list
    replaces the default, so name the layout root in it too.
  - `transact(doc)`: writes to other shared types of the same document, such
    as an activity log, in the same update, under the edit's client id
    (`doc.clientID`). Their roots must be allowed. It only writes: an update
    it applies to `doc` refuses the edit (`'imported-items'`), as that
    update's items would be returned as the edit's.
  - `tag`: the tags of the editor update. `COLLABORATION_TAG` and
    `SKIP_COLLAB_TAG` are refused (`'ignored-tag'`): the binding writes
    nothing for an update that carries them, so the edit would be lost.

  Whatever `$edit` throws (an `Error` or any other value) is rethrown as it
  is, and nothing is written or returned: `transact` does not run.
- **`readYState`** discards what opening the document writes (see
  [Store what opening writes](#store-what-opening-writes)).

The states `seedYState` and `editYState` return are compacted like the
clients' copies (garbage collected: deleted content keeps only its
tombstones), `editYState`'s also when nothing changed; the `update` sent to
clients is not. `editYState` checks the update's roots on its own
uncompacted copy of the document, which still holds the deleted items the
update refers to, and compacts the state after that check.

The documents that load a state (the headless editor's, and the one that
compacts) turn off Yjs's format cleanup (`doc.cleanupFormatting = false`),
as the clients' documents do: it would delete format items that the
clients keep, and the stored document would then read differently from
theirs once someone types there. A relay or server that loads a stored
state into a `Doc` of its own (to apply clients' updates to it, compact or
merge it) creates it with `createYDoc(state)`, which does the same; merging
updates with `mergeUpdates` needs no document:

```ts
import {createYDoc} from '@lexical/y/headless';
import {applyUpdate, encodeStateAsUpdate} from '@y/y';

// A relay's copy of a document: load what is stored, apply what clients
// send, store the result.
const doc = createYDoc(stored);
applyUpdate(doc, update);
const next = encodeStateAsUpdate(doc);
```

Each call releases its editor and document before it returns, so a
synchronous loop over many documents holds one at a time.

They throw a `YHeadlessError` with a `code`: `'not-initialized'` (no layout
record yet: seed the document first), `'read-only'` (a newer version of
the app's schema wrote to the document, a newer layout, content without a
layout record, a node type the config does not register, a node type stored
in a way its class cannot be (`STORAGE_MISMATCH_WARNING`), content its
classes throw on, or a named slot the document cannot store, which the
binding refuses to write; the error's `warnings` are the
binding's typed warnings that say which, so an app can narrow on each
one's `code` and `data.reason` instead of reading the message),
`'foreign-roots'` (the update writes to a root that is not allowed),
`'imported-items'` (`transact` applied another update to the edit's
document) or `'ignored-tag'` (`editYState`'s `tag` makes the binding write
nothing; the edit does not run).

`editYState` called without a `writer` (JavaScript, or a cast past the
type) throws a `TypeError` that says what to pass.

Warnings never refuse an edit, and the functions never throw for one. Each
warning is a `LexicalWarning` (see [Warnings](./y.md#warnings)), returned in
`editYState`'s `warnings` and passed to `config.onWarn` (default:
`console.warn` outside production; a handler that throws does not refuse
the edit). Their codes are the binding's, plus three exported from
`@lexical/y/headless` (the `YHeadlessWarningCode` type lists them all):

- `'@lexical/y/editor-warning'` (`EDITOR_WARNING`): a warning from Lexical
  or an extension that is not a `LexicalWarning`, with its message;
  `data.error` is the original.
- `'@lexical/y/follow-ups-exhausted'` (`FOLLOW_UPS_EXHAUSTED_WARNING`):
  listeners kept scheduling updates; after 8 follow-up updates
  (`data.limit`) the rest are not committed, which usually means an update
  listener that always changes the document. Once the binding writes (an
  edit, or the read of a seed it has written), an update that changes content and is made after a commit in the
  same task commits at once, as each one such a listener schedules is:
  Lexical's own guard stops such a listener instead (an `EDITOR_WARNING`),
  and what it committed is part of the update.
- `'@lexical/y/writer-new-client-id'` (`WRITER_NEW_CLIENT_ID_WARNING`): a
  writer could not continue its client id on the state, so the edit was
  written under a new one; `data.reason` says why (see [Writers](#writers)).

The binding's self-check is off unless `selfCheck: true`.

## Writers

Every Yjs update is written under a client id, and a document keeps every
client id that ever wrote to it: in its state vector, which every sync
sends, and in the bookkeeping Yjs does each time it loads the document. A
browser tab writes under one client id while it is open. `editYState`
requires a `writer`, so that every call decides which client id the server
writes under:

- **A writer** from `createYWriter(author)`: create one per agent or
  integration, once per process, and pass it to every edit it makes. It
  keeps one client id per document it edits and continues it from edit to
  edit, so a document the server edits thousands of times carries one
  client id for it.
- **`null`**: a new anonymous client id for this edit alone. Every edit that
  writes adds one to the document, for good. After 3,000 one-character
  edits, a document that a writer keeps at 3.8 KB, with a 21-byte state
  vector, stores 96 KB with a 27 KB state vector, and the next call takes
  about 25 times as long.

```ts
import {createYWriter, editYState} from '@lexical/y/headless';

// Once per process.
const agent = createYWriter('Summary agent');

// For each edit the agent makes.
const {update, state: next, clientID} = editYState(state, config, $edit, {
  writer: agent,
});
```

Two writes under one client id from different states give two different
items the same id, and Yjs cannot tell them apart: each peer keeps the one
it received first, and the document diverges with no error. So a writer
never takes a client id from you. It draws its own at random, as every Yjs
client does (a restart or another replica draws others), never one that a
call in progress writes under. It continues a client id only on a state
whose clock for that id is where its last update to that document ended (a
state that holds that update). Otherwise the edit is written under a new
client id. When the state holds the writer's id short of that point, or
another call is writing under it, a `'@lexical/y/writer-new-client-id'`
warning's `data.reason` says why:

| `reason` | When | To keep one client id |
| --- | --- | --- |
| `'stale-state'` | The state was read before the writer's last update to the document, or that update was never stored. | Run the writer's edits one after another, each on a state that holds its last update, and store every update it returns. |
| `'busy'` | `editYState` was called with the writer from inside another call with it (its `$edit`, `transact` or `onWarn`). | Run a writer's edits one after another. |
| `'range'` | The writer's client id does not fit `clientIDRange: 'uint32'`. | Use the same `clientIDRange` in every config the writer edits a document with. |
| `'foreign-writes'` | Something else wrote under the writer's client id: an app assigned `result.clientID` to a `Y.Doc`. The writer stops using that id. | Never assign a writer's client id to a document. |

A state that holds none of the writer's client ids (another document, or
one read before the writer first edited it) gets a new client id without a
warning: the writer cannot tell it from a new document. The warnings catch
the overlaps a state shows, not every one.

A writer remembers up to 10,000 client ids, about one per document it
edits, the least recently used forgotten first; a document whose id it
forgot gets a new client id on its next edit.

### Attribution

The result's `clientID` is the client id the edit wrote under, and
`writer.author` is the author the writer was created with. The writer
stores the author nowhere: credit one to the other the way your app
attributes writes, and keep that record, since a restart writes under new
client ids:

- **A registry of client ids**, such as a root of the document that maps
  each client id to a person, as a blame view reads it: write the entry
  with `transact`, in the same update (`doc.clientID` there is the edit's
  client id), and allow its root.
- **Yjs 14 attributions**, which attribute the ids an update inserts and
  deletes, whatever client id wrote them (for `writer: null` too):

```ts
import * as Y from '@y/y';

if (update !== null) {
  const attributions = Y.createContentMapFromContentIds(
    Y.createContentIdsFromUpdate(update),
    [Y.createContentAttribute('insert', agent.author)],
    [Y.createContentAttribute('delete', agent.author)],
  );
  // Merge them into the document's (Y.mergeContentMaps), and render the
  // root with Y.createAttributionsRenderer.
}
```

An update holds only the edit's own writes: an update that `transact`
applies to the document refuses the edit (`'imported-items'`).

`seedYState` takes no writer: its client id is derived from the content,
which is what makes identical seeds merge. Credit the client ids in a
seed's state vector (`Y.decodeStateVector(Y.encodeStateVectorFromUpdate(seed))`)
to whoever seeded the document: that one id, plus the temporary document's
own when a listener of the config's extensions writes once the content is
read (a value it sets on open).

## Server patterns

### Store what opening writes

Opening a document can write to it: an extension can assign a value on open
(a NodeState it sets on every block that has none, for example).
`editYState` includes those writes in its update; `readYState` does not
store them, so a value assigned on open can differ from one read to the
next. Store what opening writes once before relying on such values:

```ts
const {update, state: next} = editYState(state, config, () => {}, {writer});
if (update !== null) {
  // Store `next` and send `update` to the connected clients.
}
```

### Edits by agents and tools

An agent's edit is planned from a read, and the document can change before
the edit arrives. Follow
[Edits made by code](./y.md#edits-made-by-code-agents-tools):

- **Edit text in place.** Change the characters of a text node
  (`spliceText`) rather than replacing its block: a replaced block is a
  delete and an insert. In a line such as a paragraph, what a collaborator
  types at the same time survives, with its own formatting, at the start of
  the new text (typed at the end of the line, it can also stay at the end);
  formatting of the replaced characters does not carry over. Replacing a
  block stored as a node of its own, such as a table, deletes what was typed
  in it.
- **Check, then edit the latest state, or nothing.** Check what the edit
  names on the latest stored state: a replacement's words in the block where
  the agent read them, found there by id (the words still there, exactly
  once), and the same for words it formats or comments on (applied where
  they are found on that state, not by the read's offsets); a rewritten or
  deleted block as a whole (still where it was, and
  unchanged since the read: its type, text, formats, style, NodeState and
  children, as the checking schema exports them, so use a schema that still
  declares every field stored versions may hold); an insert's anchor block
  (still there). Check every edit of a
  batch before applying any, then apply them in order with `editYState` on
  that same latest state, checking each one again on the state the ones
  before it leave: an edit that an earlier one changes (its words changed or
  now appear twice, its block deleted or rewritten, or a block named twice)
  refuses the whole batch, a conservative rule (send dependent changes as one
  edit). When every check passes, store the result with a compare-and-set on
  the version you checked, and send the `update` to the clients. When a
  check fails, store and send nothing from the batch, and return every
  failure (which edit, the reason, and its block's content in the latest
  stored state, not in the discarded edit) and a new read to the agent, so
  that it plans again. "Every failure" means: when an initial check fails,
  every edit that fails it (the in-order pass does not run); when they all
  pass, every edit that fails in the in-order pass, where a failing edit is
  recorded and skipped, the later checks see the earlier edits that
  succeeded (also those after a failure), never the failed one applied, and
  its reason says it failed after an earlier edit. Any failure discards the
  whole temporary edit.
- **On a lost race, start over on the newer state.** When the
  compare-and-set fails, a newer state was stored after the one you checked:
  drop the state and the update computed on the older one, and run the whole
  check and the edit again on the newer state (a few times at most, then
  refuse back to the agent with a read of the state that won the last race,
  not the one that lost). Never store or send an update computed on an older
  state: its check no longer holds.
- **Merge from the read only where there is nothing to check.** Only an edit
  with nothing to check (an append, a suggestion a person accepts, an edit
  by position) runs on the state the agent read, with its `update` merged
  into the latest stored state; do not store the `state` that edit returns,
  which lacks what changed since the read.
- **Resolve block handles against the stored state.** An agent that
  addresses blocks by [handle](/docs/extensions/block-ids#showing-blocks-to-a-model)
  resolves each one in a `readYState` of the latest stored state, with the
  handles it was shown (`$resolveBlockHandle(handle, {read})`), so that a
  block deleted since the read fails, then applies the edit to that latest
  state by id (see
  [Handles and collaboration](/docs/extensions/block-ids#handles-and-collaboration)).
  Resolved in the read, a handle always finds its block, even one deleted
  since.
- **Give the agent its writer.** The edit continues the agent's client id
  when the agent has not written the document since the state it edits. When
  two runs of the agent overlap on one document, the later edit is written
  under a new client id (with a `'stale-state'` warning when the state it
  edits holds the agent's id): safe, and one more client id.

`applyChecked` below does the check, the edit (each part checked again as it
is applied), the compare-and-set and the retries; `$findWords` checks a
replacement of words. With
[`BlockIdExtension`](/docs/extensions/block-ids) in the config, as on the
clients:

```ts
import {$getBlockById} from '@lexical/extension';
import {
  createYWriter,
  editYState,
  type HeadlessYConfig,
  readYState,
} from '@lexical/y/headless';
import {$isElementNode, type TextNode} from 'lexical';

// Once per process.
const agent = createYWriter('Writing assistant');

// Your storage of one document: its latest state and a version, a store
// that succeeds only while the version is unchanged (a compare-and-set), and
// the connected clients.
interface DocStore {
  load(): Promise<{state: Uint8Array; version: number}>;
  storeIf(version: number, state: Uint8Array): Promise<boolean>;
  send(update: Uint8Array): void;
}

// Runs an agent's edit on the latest stored state. `$check` lists what is
// wrong with the edit there, every part of it checked. `$edit` makes it,
// checking each part again on the state the parts before it leave, and
// lists what failed there (an earlier part changed a later one's target).
// With any failure, from either, nothing is stored or sent: the failures go
// back with the latest state, for the agent's new read. When the store loses
// a race to a newer state, the state and the update computed on the older
// one are dropped, and the check and the edit run again on the newer state,
// `attempts` times at most; then the state that won the last race is loaded
// and returned with no failures (the document kept changing). An update
// computed on an older state is never stored or sent.
async function applyChecked<F>(
  store: DocStore,
  config: HeadlessYConfig,
  $check: () => F[],
  $edit: () => F[],
  attempts = 3,
): Promise<{failures: F[]; latest: Uint8Array} | null> {
  if (!(attempts >= 1)) {
    throw new RangeError('applyChecked: attempts must be at least 1');
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    const {state: latest, version} = await store.load();
    const failures = readYState(latest, config, $check);
    if (failures.length > 0) {
      return {failures, latest};
    }
    let failed: F[] = [];
    const {state, update} = editYState(
      latest,
      config,
      () => {
        failed = $edit();
      },
      {writer: agent},
    );
    if (failed.length > 0) {
      return {failures: failed, latest};
    }
    if (update === null) {
      return null;
    }
    if (await store.storeIf(version, state)) {
      store.send(update);
      return null;
    }
  }
  return {failures: [], latest: (await store.load()).state};
}

// The words `from` in the block with this id: the plain text node that
// holds them and their offset there, or why the edit cannot apply. They must
// occur exactly once in the block's text, and inside one text node (a tab
// does not take text, and a hashtag or a code token would keep its type
// around the new text).
function $findWords(
  id: string,
  from: string,
): {offset: number; text: TextNode} | string {
  const block = $getBlockById(id);
  if (block === null) {
    return 'the block is gone';
  }
  const all = block.getTextContent();
  const at = all.indexOf(from);
  if (from === '' || at === -1) {
    return 'the words changed';
  }
  if (all.indexOf(from, at + 1) !== -1) {
    return 'the words appear more than once';
  }
  for (const text of $isElementNode(block) ? block.getAllTextNodes() : []) {
    const offset = text.getTextContent().indexOf(from);
    if (offset !== -1) {
      return text.isSimpleText() ? {offset, text} : 'not plain text';
    }
  }
  return 'not in one text node';
}

// The agent read the blocks of `edits` ([{id, from, to}, ...]) and planned to
// replace each `from` in its block with `to`. An edit that an earlier one
// changes (its words changed or now appear twice, its block gone) refuses
// the whole batch too.

// What each edit's block holds in the latest stored state: a refusal
// reports it, also for an edit that fails only after an earlier one.
const stored = new Map<string, string | undefined>();
const $failure = (index: number, reason: string) => ({
  id: edits[index].id,
  index,
  reason,
  text: stored.get(edits[index].id),
});
const refused = await applyChecked(
  store,
  config,
  () => {
    for (const edit of edits) {
      stored.set(edit.id, $getBlockById(edit.id)?.getTextContent());
    }
    return edits.flatMap((edit, index) => {
      const found = $findWords(edit.id, edit.from);
      return typeof found === 'string' ? [$failure(index, found)] : [];
    });
  },
  () =>
    edits.flatMap((edit, index) => {
      const found = $findWords(edit.id, edit.from);
      if (typeof found === 'string') {
        return [$failure(index, `${found} after an earlier edit`)];
      }
      found.text.spliceText(found.offset, edit.from.length, edit.to);
      return [];
    }),
);
if (refused !== null) {
  // Nothing was stored: return `refused.failures` (each with its edit's
  // index and the block's text as stored) and a new read of
  // `refused.latest` to the agent.
}
```

### Edits by block id

With [`BlockIdExtension`](/docs/extensions/block-ids) in the config (as on
the clients: a config without it writes new blocks without ids), an agent
can read blocks with their ids and answer with edits addressed by id. Two
things differ from a single editor:

- **Check every target on the latest state, then edit that state, or
  nothing.** Compare each target on the latest stored state with what the
  agent read, as a whole: where it is (the path from the root to it, each
  node on it by its id or, without one, by its type and place in its
  parent) and all it holds (its type, text, formats, style, NodeState,
  children and named slots). Check every op of the answer before applying
  any, and each again, in order, as it is applied: when one is gone,
  changed, named twice, or of a shape the edit cannot make, store none, and
  send every failure back to the agent with the block's current content and
  a new read, to plan again from the latest state. Run on
  `seen`, the state the agent read, every block it read still exists, so
  `$getBlockById` finds a block a collaborator has deleted since, or the
  original of a block a collaborator has moved or replaced since: a move or
  a `replace` keeps the block's id (see
  [How ids follow edits](/docs/extensions/block-ids#how-ids-follow-edits)),
  but `@lexical/y` stores either one as a delete and an insert. The agent's
  text would then survive the merge without its block, as
  [a line without a marker](./y.md#limits): a paragraph of its own, or text
  glued to a neighboring line, depending on what is around it. The check is
  conservative: a block a collaborator typed in or formatted, or one after
  an inserted or deleted block in any of its containers, goes back too. It
  compares what the server's schema declares: a stored field that schema no
  longer declares (an older client still writing a field a newer schema
  dropped, during a rollout) is not compared, so a collaborator's change to
  it does not refuse a rewrite or a delete. Run the agent's server on a
  schema that still declares every field the stored versions may hold. Store
  the result with `applyChecked` (above): a compare-and-set on the version
  the check read, and on a lost race the check and the edit again on the
  newer state, so that no change lands between the check and the edit.
- **Edit the text in place.** Replacing the block (`block.replace(node)`, as
  in the [single-editor example](/docs/extensions/block-ids#addressing-blocks))
  writes it anew. In a line such as a paragraph, what a collaborator types
  at the same time survives, with its own formatting, at the start of the
  new text (typed at the end of the line, it can also stay at the end);
  formatting of the replaced characters does not carry over. Replacing a
  block stored as a node of its own, such as a table, deletes what was typed
  in it. Splice only the characters that changed.

```ts
import {$getBlockById, $getBlockId} from '@lexical/extension';
import {readYState} from '@lexical/y/headless';
import {
  $getRoot,
  $getSlot,
  $getSlotHost,
  $getSlotNames,
  $getSlotNameWithinHost,
  $isElementNode,
  $isRootNode,
  $isTextNode,
  type LexicalNode,
  type TextNode,
} from 'lexical';

// Changes a text node's text to `next` with one splice: the start and end
// the two texts share stay (and what collaborators type in them), and
// everything from the first difference to the last is replaced. For an
// answer that changes several separate places, splice each change on its
// own (from a diff of the two texts), so the text between them stays too.
function $setTextInPlace(text: TextNode, next: string): void {
  const prev = text.getTextContent();
  let start = 0;
  while (start < prev.length && prev[start] === next[start]) {
    start++;
  }
  let end = 0;
  while (
    end < prev.length - start &&
    end < next.length - start &&
    prev[prev.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end++;
  }
  text.spliceText(
    start,
    prev.length - start - end,
    next.slice(start, next.length - end),
  );
}

// The text node of a block that this sketch edits in place, or null: the
// block's only child, plain text, and no named slots. A tab does not take
// text, a hashtag or a code token would keep its type around the new text,
// and the text of a named slot is part of the block's text but not of that
// child.
function $plainTextOf(block: LexicalNode | null): TextNode | null {
  if (
    !$isElementNode(block) ||
    $getSlotNames(block).length > 0 ||
    block.getChildrenSize() !== 1
  ) {
    return null;
  }
  const text = block.getFirstChild();
  return $isTextNode(text) && text.isSimpleText() ? text : null;
}

// A node as a whole: what it exports (its type, text, formats, style and
// NodeState), its children and its named slots, each as a whole.
function $subtree(node: LexicalNode): unknown {
  const slots: Record<string, unknown> = {};
  for (const name of $getSlotNames(node)) {
    const slot = $getSlot(node, name);
    slots[name] = slot === null ? null : $subtree(slot);
  }
  return {
    ...node.exportJSON(),
    children: $isElementNode(node) ? node.getChildren().map($subtree) : [],
    slots,
  };
}

// Where the block with this id is and all it holds, or null when no block
// has the id: the path from it up to the root (through the hosts of named
// slots), each node on it by its id or, for one without (a table cell, by
// default), by its type, and each by its place: the slot it fills, or its
// index in its parent; and the block as a whole. A collaborator's move of
// the block or of a container it is in changes the path; any change inside
// it (text, a format, a style, a NodeState, a child) changes the rest, as far
// as the server's node classes export it: a stored field that this schema
// no longer declares is not compared.
function $blockAt(id: string): string | null {
  const block = $getBlockById(id);
  if (block === null) {
    return null;
  }
  const path: unknown[] = [];
  for (
    let node: LexicalNode | null = block;
    node !== null && !$isRootNode(node);
    node = node.getParent() ?? $getSlotHost(node)
  ) {
    path.push([
      $getBlockId(node) ?? node.getType(),
      $getSlotNameWithinHost(node) ?? node.getIndexWithinParent(),
    ]);
  }
  return JSON.stringify([path, $subtree(block)]);
}

// 1. What the agent reads, from `seen`, and each block as a whole.
const blocks = readYState(seen, config, () =>
  $getRoot()
    .getChildren()
    .map(node => {
      const id = $getBlockId(node)!;
      return {at: $blockAt(id), id, text: node.getTextContent()};
    }),
);

// 2. What it answers, seconds later: [{id: 'b7', text: 'New text'}, ...].

// 3. Every op checked on the latest state, then applied there by id in
// order, each checked again first; all of them or none. An answer that names
// a block twice is refused.

// What each op's block holds in the latest stored state, for a refusal.
const stored = new Map<string, string | undefined>();
const $reason = (op: {id: string}) => {
  const at = $blockAt(op.id);
  return ops.filter(other => other.id === op.id).length > 1
    ? 'the block is named twice'
    : at === null
      ? 'the block is gone'
      : at !== blocks.find(block => block.id === op.id)?.at
        ? 'the block changed'
        : $plainTextOf($getBlockById(op.id)) === null
          ? 'not plain text'
          : null;
};
const $failure = (index: number, reason: string) => ({
  id: ops[index].id,
  index,
  reason,
  text: stored.get(ops[index].id),
});
const refused = await applyChecked(
  store,
  config,
  () => {
    for (const op of ops) {
      stored.set(op.id, $getBlockById(op.id)?.getTextContent());
    }
    return ops.flatMap((op, index) => {
      const reason = $reason(op);
      return reason === null ? [] : [$failure(index, reason)];
    });
  },
  () =>
    ops.flatMap((op, index) => {
      const reason = $reason(op);
      if (reason !== null) {
        return [$failure(index, `${reason} after an earlier op`)];
      }
      $setTextInPlace($plainTextOf($getBlockById(op.id))!, op.text);
      return [];
    }),
);
if (refused !== null) {
  // Nothing was stored: send `refused.failures` (each with its op's index and
  // the block's text as stored) and a new read of `refused.latest` to the
  // agent.
}
```

A block with several text nodes (formats, links) needs the same idea across
its nodes: splice where the text differs, and leave the nodes before and
after the change alone.

### One edit at a time per document

Run a document's server edits one after another, each on the latest stored
state (an agent's planned edit too, after its check; only an edit merged
from the agent's read runs on that read, see
[Edits by agents and tools](#edits-by-agents-and-tools)). Two edits run at
once from the same state each return a state without the other's update,
and storing both loses one. If edits must run in parallel, merge each
`update` into the latest stored state instead of storing the returned
`state` (an edit with nothing to check), or store with a compare-and-set and
start a checked edit over on a lost race, as `applyChecked` does. Clients'
concurrent edits merge with the server's like any peer's. Run one after
another, a writer's edits also keep one client id per document.

The same goes for everything that writes the stored state, clients' updates
included: a write that replaces it with a state computed from an older read
drops what was stored in between. Write each document's state from one
process at a time, or store with a compare-and-set on a version and, when it
fails, merge the update into the newer state and store again (merge the
returned `update`; do not run `$edit` again). A checked edit is the
exception: its check held on the older state only, so on a lost race it runs
the check and `$edit` again on the newer state instead of merging (see
[Edits by agents and tools](#edits-by-agents-and-tools)).

### Converting a `@lexical/yjs` document

Load the old document into an editor with `@lexical/yjs`, seed its content,
and merge the seed into the stored Yjs 14 document. The seed holds only the
`@lexical/y` root, so the old root is left as it was:

```ts
import {createYDoc, seedYState} from '@lexical/y/headless';
import {applyUpdate, encodeStateAsUpdate} from '@y/y';
import {$getRoot, $parseSerializedNode} from 'lexical';

// `old`: the old editor's `getEditorState().toJSON()`.
const seed = seedYState(config, () => {
  for (const child of old.root.children) {
    $getRoot().append($parseSerializedNode(child));
  }
});
// Keeps every format item, as the clients do.
const doc = createYDoc(stored);
applyUpdate(doc, seed);
const converted = encodeStateAsUpdate(doc);
```

Edits that old clients make after the conversion stay in the old root, so
upgrade every client of the document at the same time.

## API reference

[`@lexical/y/headless`](/docs/api/modules/lexical_y/headless)
