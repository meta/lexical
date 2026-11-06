/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  applyUpdate,
  applyUpdateV2,
  ContentAny,
  ContentBinary,
  ContentDoc,
  ContentEmbed,
  ContentFormat,
  ContentJSON,
  ContentString,
  ContentType,
  createID,
  createIdSet,
  createRelativePositionFromJSON,
  decodeUpdate,
  decodeUpdateV2,
  diffUpdateV2,
  Doc,
  encodeStateAsUpdate,
  encodeStateAsUpdateV2,
  encodeStateVector,
  findIndexSS,
  findRootTypeKey,
  type GC,
  getItemCleanStart,
  type ID,
  type IdSet,
  Item,
  iterateStructsByIdSet,
  mergeIdSets,
  mergeUpdates,
  mergeUpdatesV2,
  Node as YNode,
  RelativePosition,
  relativePositionToJSON,
  Skip,
  type Transaction,
  tryGc,
  UndoManager,
} from '@y/y';

import {
  encodeStateVector as encodeGapStateVector,
  integrateHeldBehindGapsWith,
  structIntegrated,
} from './LoadFully';
import {SUPPORTED_YJS_VERSION} from './SupportedYjs';

/*
 * The Yjs contract: what @lexical/y uses of @y/y, and a check that the @y/y
 * the app loaded provides it.
 *
 * The binding is coupled to one exact @y/y version on purpose: it writes
 * through its own cursor on Yjs items and reads struct fields that are not
 * public API (see Cursor). A package manager only warns about a peer
 * dependency it cannot satisfy (pnpm by default, npm with
 * --legacy-peer-deps), so an app can still run another @y/y. @y/y exposes no
 * version at run time: no export or constant, and its duplicate-import flag
 * (`globalThis['__ $YJS14$ __']`) is only `true`; its `package.json`
 * subpath needs a JSON import that not every bundler or runtime supports,
 * and synchronously none. The exact version is enforced by the peer
 * dependency; at run time the check probes the contract itself,
 * once per module, on a scratch document: every export below is a
 * function, every member below has the kind of value the binding expects on
 * an object of that kind, and every event below fires. Any difference
 * refuses the binding with a YUnsupportedYjsError before it writes anything.
 *
 * Members are checked through property reads typed against @y/y's
 * declarations (not by name), so tsc fails on a member the declarations
 * drop, and a build that renames properties renames them here as it does in
 * the binding. Arities are not compared: transpilers change
 * `Function#length` (default and destructured parameters).
 *
 * The lists are the contract. YjsContract.test derives, with the TypeScript
 * checker, everything the package's sources use of @y/y (value imports,
 * `new`, members, destructured fields, options and event names) and fails
 * when it differs from these lists in either direction: a new use of a Yjs
 * export, field, method, option or event lands with its entry here.
 */

/** The value exports of @y/y the binding uses. */
export const YJS_EXPORTS = [
  'ContentAny',
  'ContentBinary',
  'ContentDoc',
  'ContentEmbed',
  'ContentFormat',
  'ContentJSON',
  'ContentString',
  'ContentType',
  'Doc',
  'Item',
  'Node',
  'RelativePosition',
  'Skip',
  'UndoManager',
  'applyUpdate',
  'applyUpdateV2',
  'createID',
  'createIdSet',
  'createRelativePositionFromJSON',
  'decodeUpdate',
  'decodeUpdateV2',
  'diffUpdateV2',
  'encodeStateAsUpdate',
  'encodeStateAsUpdateV2',
  'encodeStateVector',
  'findIndexSS',
  'findRootTypeKey',
  'getItemCleanStart',
  'iterateStructsByIdSet',
  'mergeIdSets',
  'mergeUpdates',
  'mergeUpdatesV2',
  'relativePositionToJSON',
  'tryGc',
] as const;

type StructStore = Doc['store'];
type IdRanges = NonNullable<ReturnType<IdSet['clients']['get']>>;
type IdRange = ReturnType<IdRanges['getIds']>[number];
type StackItem = UndoManager['undoStack'][number];
type AbstractContent = Item['content'];
type DecodedUpdate = ReturnType<typeof decodeUpdate>;
type DecodedUpdateV2 = ReturnType<typeof decodeUpdateV2>;
type PendingStructs = NonNullable<StructStore['pendingStructs']>;
interface StackItemEvent {
  stackItem: StackItem;
  origin: unknown;
}

export const isFunction = (value: unknown): boolean =>
  typeof value === 'function';
export const isObject = (value: unknown): boolean =>
  typeof value === 'object' && value !== null;
/** A field that may hold null (an empty pointer), never undefined. */
export const isSet = (value: unknown): boolean => value !== undefined;
export const isNumber = (value: unknown): boolean => typeof value === 'number';
export const isBoolean = (value: unknown): boolean =>
  typeof value === 'boolean';
/** A Map from any realm (@y/y may run in another one, such as a VM's). */
const isMap = (value: unknown): boolean => {
  try {
    Map.prototype.has.call(value, undefined);
    return true;
  } catch {
    return false;
  }
};

/**
 * The members (fields, getters, methods) the binding reads or calls, by the
 * name of the @y/y type that declares them, each with the check of its
 * value. `DocOpts` and `UndoManagerOptions` are constructor options the
 * binding passes (checked on what the constructor kept); `StackItemEvent`
 * is the payload of the undo manager's stack events; `decodeUpdate` is that
 * function's result.
 *
 * @__NO_SIDE_EFFECTS__
 */
export function yjsMembers() {
  return {
    AbstractContent: {
      getContent: (c: AbstractContent) => isFunction(c.getContent),
    },
    ContentFormat: {
      key: (c: ContentFormat) => typeof c.key === 'string',
      value: (c: ContentFormat) => isSet(c.value),
    },
    ContentString: {
      str: (c: ContentString) => typeof c.str === 'string',
    },
    ContentType: {
      type: (c: ContentType) => isObject(c.type),
    },
    Doc: {
      _transaction: (d: Doc) => isSet(d._transaction),
      _transactionCleanups: (d: Doc) => Array.isArray(d._transactionCleanups),
      cleanupFormatting: (d: Doc) => isBoolean(d.cleanupFormatting),
      clientID: (d: Doc) => isNumber(d.clientID),
      destroy: (d: Doc) => isFunction(d.destroy),
      gc: (d: Doc) => isBoolean(d.gc),
      gcFilter: (d: Doc) => isFunction(d.gcFilter),
      get: (d: Doc) => isFunction(d.get),
      isDestroyed: (d: Doc) => isBoolean(d.isDestroyed),
      off: (d: Doc) => isFunction(d.off),
      on: (d: Doc) => isFunction(d.on),
      once: (d: Doc) => isFunction(d.once),
      share: (d: Doc) => isMap(d.share),
      store: (d: Doc) => isObject(d.store),
      transact: (d: Doc) => isFunction(d.transact),
    },
    DocOpts: {
      gc: (d: Doc) => d.gc === false,
    },
    GC: {
      id: (g: GC) => isObject(g.id),
      length: (g: GC) => isNumber(g.length),
    },
    ID: {
      client: (id: ID) => isNumber(id.client),
      clock: (id: ID) => isNumber(id.clock),
    },
    IdRange: {
      clock: (r: IdRange) => isNumber(r.clock),
      len: (r: IdRange) => isNumber(r.len),
    },
    IdRanges: {
      getIds: (r: IdRanges) => isFunction(r.getIds),
    },
    IdSet: {
      add: (s: IdSet) => isFunction(s.add),
      clients: (s: IdSet) => isMap(s.clients),
      hasId: (s: IdSet) => isFunction(s.hasId),
    },
    Item: {
      content: (it: Item) => isObject(it.content),
      countable: (it: Item) => isBoolean(it.countable),
      delete: (it: Item) => isFunction(it.delete),
      deleted: (it: Item) => isBoolean(it.deleted),
      id: (it: Item) => isObject(it.id),
      integrate: (it: Item) => isFunction(it.integrate),
      keep: (it: Item) => isBoolean(it.keep),
      lastId: (it: Item) => isObject(it.lastId),
      left: (it: Item) => isSet(it.left),
      length: (it: Item) => isNumber(it.length),
      origin: (it: Item) => isSet(it.origin),
      parent: (it: Item) => isSet(it.parent),
      parentSub: (it: Item) => isSet(it.parentSub),
      redone: (it: Item) => isSet(it.redone),
      right: (it: Item) => isSet(it.right),
      rightOrigin: (it: Item) => isSet(it.rightOrigin),
    },
    RelativePosition: {
      assoc: (p: RelativePosition) => isNumber(p.assoc),
      item: (p: RelativePosition) => isSet(p.item),
    },
    Skip: {
      id: (k: Skip) => isObject(k.id),
      length: (k: Skip) => isNumber(k.length),
    },
    StackItem: {
      deletes: (s: StackItem) => isObject(s.deletes),
      inserts: (s: StackItem) => isObject(s.inserts),
      meta: (s: StackItem) => isMap(s.meta),
    },
    StackItemEvent: {
      origin: (e: StackItemEvent) => isSet(e.origin),
      stackItem: (e: StackItemEvent) => isObject(e.stackItem),
    },
    StructStore: {
      clients: (s: StructStore) => isMap(s.clients),
      getClock: (s: StructStore) => isFunction(s.getClock),
      getItem: (s: StructStore) => isFunction(s.getItem),
      pendingDs: (s: StructStore) => isSet(s.pendingDs),
      pendingStructs: (s: StructStore) => isSet(s.pendingStructs),
    },
    // The gap repair (LoadFully) reads a pending update in format V2.
    'StructStore.pendingStructs': {
      missing: (p: PendingStructs) => isMap(p.missing),
      update: (p: PendingStructs) => ArrayBuffer.isView(p.update),
    },
    Transaction: {
      changed: (tr: Transaction) => isMap(tr.changed),
      deleteSet: (tr: Transaction) => isObject(tr.deleteSet),
      doc: (tr: Transaction) => isObject(tr.doc),
      insertSet: (tr: Transaction) => isObject(tr.insertSet),
      local: (tr: Transaction) => isBoolean(tr.local),
      origin: (tr: Transaction) => isSet(tr.origin),
    },
    UndoManager: {
      canRedo: (u: UndoManager) => isFunction(u.canRedo),
      canUndo: (u: UndoManager) => isFunction(u.canUndo),
      clear: (u: UndoManager) => isFunction(u.clear),
      currStackItem: (u: UndoManager) => u.currStackItem === null,
      destroy: (u: UndoManager) => isFunction(u.destroy),
      doc: (u: UndoManager) => isObject(u.doc),
      emit: (u: UndoManager) => isFunction(u.emit),
      on: (u: UndoManager) => isFunction(u.on),
      redo: (u: UndoManager) => isFunction(u.redo),
      redoStack: (u: UndoManager) => Array.isArray(u.redoStack),
      redoing: (u: UndoManager) => u.redoing === false,
      undo: (u: UndoManager) => isFunction(u.undo),
      undoStack: (u: UndoManager) => Array.isArray(u.undoStack),
      undoing: (u: UndoManager) => u.undoing === false,
    },
    UndoManagerOptions: {
      captureTimeout: (u: UndoManager) => u.captureTimeout === 0,
      captureTransaction: (u: UndoManager) =>
        u.captureTransaction === PROBE_CAPTURE_TRANSACTION,
      deleteFilter: (u: UndoManager) => u.deleteFilter === PROBE_DELETE_FILTER,
      trackedOrigins: (u: UndoManager) => u.trackedOrigins.has(PROBE_ORIGIN),
    },
    YNode: {
      _hasFormatting: (n: YNode) => isBoolean(n._hasFormatting),
      _item: (n: YNode) => isSet(n._item),
      _map: (n: YNode) => isMap(n._map),
      _searchMarker: (n: YNode) => isSet(n._searchMarker),
      _start: (n: YNode) => isSet(n._start),
      deleteAttr: (n: YNode) => isFunction(n.deleteAttr),
      doc: (n: YNode) => isSet(n.doc),
      getAttr: (n: YNode) => isFunction(n.getAttr),
      getAttrs: (n: YNode) => isFunction(n.getAttrs),
      length: (n: YNode) => isNumber(n.length),
      name: (n: YNode) => isSet(n.name),
      parent: (n: YNode) => isSet(n.parent),
      setAttr: (n: YNode) => isFunction(n.setAttr),
    },
    decodeUpdate: {
      ds: (u: DecodedUpdate) => isObject(u.ds),
      structs: (u: DecodedUpdate) => Array.isArray(u.structs),
    },
    decodeUpdateV2: {
      structs: (u: DecodedUpdateV2) => Array.isArray(u.structs),
    },
  };
}

const __DEV__ = process.env.NODE_ENV !== 'production';

/** The kinds only the gap probe (probeGapLoad) makes. */
const GAP_PROBE_KINDS: ReadonlySet<string> = new Set([
  'StructStore.pendingStructs',
  'decodeUpdateV2',
]);

const PROBE_GUID = '@lexical/y/yjs-probe';
/** The undo manager options the probe passes, checked on what it kept. */
const PROBE_ORIGIN = {};
const PROBE_DELETE_FILTER = () => true;
const PROBE_CAPTURE_TRANSACTION = () => true;

/** The events the binding listens to, by emitter. */
export const YJS_EVENTS = {
  Doc: [
    'afterAllTransactions',
    'afterTransaction',
    'beforeObserverCalls',
    'beforeTransaction',
    'destroy',
    'update',
  ],
  UndoManager: ['stack-cleared', 'stack-item-added', 'stack-item-popped'],
} as const;

/** @experimental The code of {@link YUnsupportedYjsError}. */
export const UNSUPPORTED_YJS_ERROR = '@lexical/y/unsupported-yjs';

/**
 * @experimental Why {@link YUnsupportedYjsError} refused:
 * - `'changed-internals'`: the `@y/y` the app loaded is not the supported
 *   version: exports, members or events the binding uses are missing or
 *   changed (`data.found` names them).
 * - `'other-copy'`: the document comes from another copy of `@y/y` than
 *   the one `@lexical/y` loaded, so the binding's `instanceof` checks on its
 *   items would fail.
 */
export type YUnsupportedYjsReason = 'changed-internals' | 'other-copy';

/** @experimental The data of {@link YUnsupportedYjsError}. */
export interface YUnsupportedYjsData {
  /** The exact `@y/y` version this `@lexical/y` supports. */
  readonly supported: string;
  /**
   * What the check found instead: for `'changed-internals'`, each missing
   * or changed part of the contract (`'getItemCleanStart'`,
   * `'Item#parentSub'`, `'UndoManager@stack-cleared'`);
   * for `'other-copy'`, what came from the other copy.
   */
  readonly found: readonly string[];
  readonly reason: YUnsupportedYjsReason;
}

/**
 * @experimental Thrown by `createYDoc`, by the `YBinding` constructor (so by
 * `YCollabExtension`) and by the headless helpers when the `@y/y` the app
 * runs is not the one `@lexical/y` supports, before anything is written.
 * Fix: install exactly `@y/y@<data.supported>`, once per app. There is no
 * way to turn the check off.
 */
export class YUnsupportedYjsError extends Error {
  readonly code: typeof UNSUPPORTED_YJS_ERROR;
  readonly data: YUnsupportedYjsData;
  constructor(data: YUnsupportedYjsData) {
    super(unsupportedYjsMessage(data));
    this.name = 'YUnsupportedYjsError';
    this.code = UNSUPPORTED_YJS_ERROR;
    this.data = Object.freeze({
      ...data,
      found: Object.freeze(data.found.slice()),
    });
  }
}

function unsupportedYjsMessage({
  found,
  reason,
  supported,
}: YUnsupportedYjsData): string {
  if (reason === 'other-copy') {
    return `@lexical/y: the ${found.join(' and ')} comes from another copy of @y/y than the one @lexical/y loaded. Install @y/y@${supported} once per app and create the document with createYDoc.`;
  }
  const shown = found.slice(0, 5).join(', ');
  const more = found.length > 5 ? `, and ${found.length - 5} more` : '';
  return `@lexical/y supports exactly @y/y ${supported}, and the @y/y the app loaded differs (${shown}${more}). Install @y/y@${supported}, once per app.`;
}

/**
 * The exports the check uses, named statically (a namespace import read by
 * key would keep every export of @y/y in an app's bundle). Only what the
 * binding imports: a new named import would fail to link, before this
 * check, in native ES modules without it.
 *
 * @__NO_SIDE_EFFECTS__
 */
function yjsExports() {
  return {
    ContentAny,
    ContentBinary,
    ContentDoc,
    ContentEmbed,
    ContentFormat,
    ContentJSON,
    ContentString,
    ContentType,
    Doc,
    Item,
    Node: YNode,
    RelativePosition,
    Skip,
    UndoManager,
    applyUpdate,
    applyUpdateV2,
    createID,
    createIdSet,
    createRelativePositionFromJSON,
    decodeUpdate,
    decodeUpdateV2,
    diffUpdateV2,
    encodeStateAsUpdate,
    encodeStateAsUpdateV2,
    encodeStateVector,
    findIndexSS,
    findRootTypeKey,
    getItemCleanStart,
    iterateStructsByIdSet,
    mergeIdSets,
    mergeUpdates,
    mergeUpdatesV2,
    relativePositionToJSON,
    tryGc,
  };
}

export type YjsExports = ReturnType<typeof yjsExports>;

/**
 * Probe `y` against the contract: the list of what is missing or changed,
 * empty when it matches. Writes only to a scratch document of its own.
 */
export function probeYjs(y: YjsExports = yjsExports()): string[] {
  const found: string[] = [];
  const exportsOf = y as unknown as Record<string, unknown>;
  for (const name of YJS_EXPORTS) {
    if (typeof exportsOf[name] !== 'function') {
      found.push(name);
    }
  }
  if (found.length > 0) {
    return found;
  }
  try {
    probeMembers(y, found);
  } catch (error) {
    // Making the scratch document itself threw.
    found.push(
      `probe threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return found;
}

/**
 * What the gap repair (LoadFully) relies on, end to end, on scratch
 * documents with two writers: a struct held pending behind a blocked struct
 * of its client (a batched update), the pending update in format V2 (not
 * V1) with its `missing`, diffUpdateV2's cut by a state vector in format V1
 * (one client from a clock, every other client past its end), the store
 * read for what is integrated (an item counts, a Skip does not), each
 * writer's later struct integrated by the repair, and the repaired document
 * converging, byte for byte, with one that got every update once the
 * missing ones arrive. Upstream: "encodeStateAsUpdate drops text the doc
 * shows after it integrated a struct across a clock gap" (@y/y
 * 14.0.0-rc.29).
 */
function probeGapLoad(
  y: YjsExports,
  sample: (kind: string, value: unknown) => void,
  found: string[],
): void {
  const docs: Doc[] = [];
  const make = (clientID: number) => {
    const d = new y.Doc({gc: false, guid: PROBE_GUID});
    d.clientID = clientID;
    d.cleanupFormatting = false;
    docs.push(d);
    return d;
  };
  try {
    const text = (d: Doc) => {
      let s = '';
      for (let it = d.get('t')._start; it !== null; it = it.right) {
        if (!it.deleted && it.content instanceof y.ContentString) {
          s += it.content.str;
        }
      }
      return s;
    };
    // A base text "AB" (client 1). Writers 2 and 3 each write a struct after
    // A, one between A and it (it depends on it), and one after B (it does
    // not): "x", "y", "z" and "u", "v", "w".
    const base = make(1);
    base.get('t').insert(0, 'AB');
    const updates: Uint8Array<ArrayBuffer>[][] = [];
    for (const [client, chars] of [
      [2, 'xyz'],
      [3, 'uvw'],
    ] as const) {
      const writer = make(client);
      y.applyUpdate(writer, y.encodeStateAsUpdate(base));
      const own: Uint8Array<ArrayBuffer>[] = [];
      writer.on('update', (u: Uint8Array) => own.push(new Uint8Array(u)));
      writer.transact(() => writer.get('t').insert(1, chars[0]));
      writer.transact(() => writer.get('t').insert(1, chars[1]));
      writer.transact(() => writer.get('t').insert(4, chars[2]));
      updates.push(own);
    }
    // Without each writer's first struct: its second waits for it, and its
    // third waits behind the second in the batch.
    const loaded = make(4);
    y.applyUpdate(loaded, y.encodeStateAsUpdate(base));
    y.applyUpdate(
      loaded,
      y.mergeUpdates([
        updates[0][1],
        updates[0][2],
        updates[1][1],
        updates[1][2],
      ]),
    );
    const pending = loaded.store.pendingStructs;
    if (pending === null || text(loaded) !== 'AB') {
      found.push(
        'gap repair: a batched struct behind a blocked one is not held pending',
      );
      return;
    }
    sample('StructStore.pendingStructs', pending);
    const decoded = y.decodeUpdateV2(pending.update);
    sample('decodeUpdateV2', decoded);
    const clocks = (structs: typeof decoded.structs, client: number) =>
      structs
        .filter(s => !(s instanceof y.Skip) && s.id.client === client)
        .map(s => s.id.clock)
        .sort((a, b) => a - b)
        .join();
    if (
      clocks(decoded.structs, 2) !== '1,2' ||
      clocks(decoded.structs, 3) !== '1,2' ||
      pending.missing.get(2) !== 0 ||
      pending.missing.get(3) !== 0
    ) {
      found.push(
        'gap repair: the pending update (format V2) or its missing clocks changed',
      );
      return;
    }
    // Format V2: read as V1 (applyUpdate, diffUpdate), it would silently
    // give nothing back.
    let readsAsV1 = false;
    try {
      readsAsV1 =
        y.decodeUpdate(pending.update).structs.length ===
        decoded.structs.length;
    } catch {
      // Not V1, as expected.
    }
    if (readsAsV1) {
      found.push('gap repair: the pending update is no longer in format V2');
      return;
    }
    // The repair writes its state vectors itself (format V1; Yjs writes
    // the clients in descending order).
    const encoded = y.encodeStateVector(base);
    const ours = encodeGapStateVector([[1, 2]]);
    // Writer 2 from its clock 2, writer 3 past its end: writer 2's third
    // struct alone.
    const cut = y.decodeUpdateV2(
      y.diffUpdateV2(
        pending.update,
        encodeGapStateVector([
          [2, 2],
          [3, 3],
        ]),
      ),
    ).structs;
    // Two pending updates merged (the repair keeps and merges every one it
    // clears): both writers' structs.
    const merged = y.decodeUpdateV2(
      y.mergeUpdatesV2([
        y.diffUpdateV2(
          pending.update,
          encodeGapStateVector([
            [2, 2],
            [3, 3],
          ]),
        ),
        y.diffUpdateV2(
          pending.update,
          encodeGapStateVector([
            [3, 2],
            [2, 3],
          ]),
        ),
      ]),
    ).structs;
    if (
      encoded.length !== ours.length ||
      encoded.some((byte, i) => byte !== ours[i]) ||
      clocks(cut, 2) !== '2' ||
      clocks(cut, 3) !== '' ||
      clocks(merged, 2) !== '2' ||
      clocks(merged, 3) !== '2'
    ) {
      found.push(
        'gap repair: a state vector (format V1), the diffUpdateV2 cut by it or mergeUpdatesV2 changed',
      );
      return;
    }
    // The store as the repair reads it: the base's struct is integrated,
    // a writer's missing first struct is not.
    if (
      !structIntegrated(y, loaded, {client: 1, clock: 0}) ||
      structIntegrated(y, loaded, {client: 2, clock: 0})
    ) {
      found.push('gap repair: the store no longer reads as integrated');
      return;
    }
    // The repair itself: "z" and "w" are integrated past the blocked "y"
    // and "v", which are pending again.
    const repaired = integrateHeldBehindGapsWith(y, loaded, undefined, false);
    const shown = text(loaded);
    if (
      !shown.includes('z') ||
      !shown.includes('w') ||
      shown.includes('y') ||
      loaded.store.pendingStructs === null
    ) {
      found.push(
        'gap repair: a struct applied on its own is not integrated past a blocked one',
      );
      return;
    }
    // The repair plans each suffix's run from the dependency rules it
    // relies on; a run that integrates otherwise means they changed.
    if (repaired.failedCuts !== 0) {
      found.push('gap repair: @y/y no longer integrates as the plan predicts');
      return;
    }
    // A format item: its key read on a decoded struct, and the format rule
    // (an opener whose closer stays blocked is held back with it).
    const formatBase = make(6);
    formatBase.get('t').insert(0, 'abcd');
    const formatter = make(7);
    y.applyUpdate(formatter, y.encodeStateAsUpdate(formatBase));
    const formatUpdates: Uint8Array<ArrayBuffer>[] = [];
    formatter.on('update', (u: Uint8Array) =>
      formatUpdates.push(new Uint8Array(u)),
    );
    const ft = formatter.get('t');
    // Lost: "L" after "c". Then one update: "M" after "L" (blocked), and
    // a format over "b".."L" (its opener after "a", integrable once "M" is
    // passed; its closer after "L", blocked), held behind "M".
    formatter.transact(() => ft.insert(3, 'L'));
    formatter.transact(() => {
      ft.insert(4, 'M');
      ft.format(1, 3, {probe: true});
    });
    const formatted = make(8);
    y.applyUpdate(formatted, y.encodeStateAsUpdate(formatBase));
    y.applyUpdate(formatted, formatUpdates[1]);
    const held = formatted.store.pendingStructs;
    const keys =
      held === null
        ? []
        : y
            .decodeUpdateV2(held.update)
            .structs.map(s => (s as {content?: unknown}).content)
            .filter(c => c instanceof y.ContentFormat)
            .map(c => (c as ContentFormat).key);
    if (keys.join() !== 'probe,probe') {
      found.push('gap repair: a format item read on a decoded struct changed');
      return;
    }
    integrateHeldBehindGapsWith(y, formatted, undefined, false);
    for (let it = formatted.get('t')._start; it !== null; it = it.right) {
      if (it.content instanceof y.ContentFormat) {
        found.push(
          'gap repair: a format item was integrated while its closer stays blocked',
        );
        return;
      }
    }
    // Once the missing updates arrive, it converges with a document that
    // got every update.
    const whole = make(5);
    y.applyUpdate(whole, y.encodeStateAsUpdate(base));
    for (const own of updates) {
      for (const u of own) {
        y.applyUpdate(whole, u);
      }
    }
    y.applyUpdate(loaded, updates[0][0]);
    y.applyUpdate(loaded, updates[1][0]);
    const a = y.encodeStateAsUpdate(loaded);
    const b = y.encodeStateAsUpdate(whole);
    if (
      loaded.store.pendingStructs !== null ||
      a.length !== b.length ||
      a.some((byte, i) => byte !== b[i])
    ) {
      found.push('gap repair: the repaired document does not converge');
    }
  } catch (error) {
    found.push(
      `gap repair threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    for (const d of docs) {
      d.destroy();
    }
  }
}

/**
 * Exercise, on a scratch document, the kinds of objects the binding meets,
 * and check every member of {@link yjsMembers} on one of each and every
 * event of {@link YJS_EVENTS}.
 */
function probeMembers(y: YjsExports, found: string[]): void {
  // Each kind is checked when its first object is made, before the probe
  // changes it (an assignment would create a renamed field).
  const members = yjsMembers() as unknown as Record<
    string,
    Record<string, (value: object) => boolean>
  >;
  const sampled = new Set<string>();
  /** The kinds checked, and for content each class (by identity: a
   * minifier can give every class the same name). */
  const checked = new Set<unknown>();
  /** Check `value` as a `kind`, once per kind (once per `variant` of it,
   * named `label`). */
  const sample = (
    kind: string,
    value: unknown,
    variant: unknown = kind,
    label = '',
  ) => {
    if (checked.has(variant) || typeof value !== 'object' || value === null) {
      return;
    }
    checked.add(variant);
    sampled.add(kind);
    const variantLabel = label;
    for (const [member, check] of Object.entries(members[kind])) {
      let ok = false;
      try {
        ok = check(value);
      } catch {
        // A getter that throws is a changed member too.
      }
      if (!ok) {
        found.push(
          `${kind}${variantLabel === '' ? '' : `(${variantLabel})`}#${member}`,
        );
      }
    }
  };
  const events = new Set<string>();
  // A fixed guid: each document then draws only its client id from the
  // app's randomness (a seeded one shifts every later id by each draw).
  const doc = new y.Doc({gc: false, guid: PROBE_GUID});
  // A garbage collected document, for a GC struct (the items of a deleted
  // node).
  const collected = new y.Doc({guid: PROBE_GUID});
  sample('Doc', doc);
  sample('DocOpts', doc);
  sample('StructStore', doc.store);
  const um: {destroy?: () => void} = {};
  let threw: unknown = null;
  try {
    doc.cleanupFormatting = false;
    const root = doc.get('probe');
    for (const event of YJS_EVENTS.Doc) {
      doc.on(event, () => events.add(`Doc@${event}`));
    }
    const undoManager = new y.UndoManager(root, {
      captureTimeout: 0,
      captureTransaction: PROBE_CAPTURE_TRANSACTION,
      deleteFilter: PROBE_DELETE_FILTER,
      trackedOrigins: new Set<unknown>([PROBE_ORIGIN]),
    });
    um.destroy = () => undoManager.destroy();
    sample('UndoManager', undoManager);
    sample('UndoManagerOptions', undoManager);
    for (const event of YJS_EVENTS.UndoManager) {
      undoManager.on(event, (payload: unknown) => {
        events.add(`UndoManager@${event}`);
        if (event === 'stack-item-added') {
          sample('StackItemEvent', payload);
          sample('StackItem', (payload as {stackItem?: unknown}).stackItem);
        }
      });
    }
    doc.transact(tr => {
      sample('Transaction', tr);
      root.insert(0, 'ab');
      root.insert(2, [new y.Node('probe')]);
      root.format(0, 1, {probe: [1]});
      root.setAttr('probe', 1);
      // Bytes made by @y/y, which may run in another realm (it switches on
      // the value's constructor).
      root.setAttr('probeBinary', y.encodeStateAsUpdate(collected));
    }, PROBE_ORIGIN);
    // Every kind of content the binding meets (text, formats, nodes,
    // attribute values), each against the abstract content contract.
    const contents: unknown[] = [];
    for (let it = root._start; it !== null; it = it.right) {
      sample('Item', it);
      sample('ID', it.id);
      contents.push(it.content);
      if (it.content instanceof y.ContentString) {
        sample('ContentString', it.content);
      } else if (it.content instanceof y.ContentFormat) {
        sample('ContentFormat', it.content);
      } else if (it.content instanceof y.ContentType) {
        sample('ContentType', it.content);
        sample('YNode', it.content.type);
      }
    }
    root._map.forEach(item => contents.push(item.content));
    for (const content of contents) {
      const klass = (content as {constructor: {name: string}}).constructor;
      sample('AbstractContent', content, klass, klass.name || '?');
    }
    const ids = y.createIdSet();
    ids.add(1, 0, 2);
    sample('IdSet', ids);
    const ranges = ids.clients.get(1);
    sample('IdRanges', ranges);
    sample('IdRange', ranges && ranges.getIds()[0]);
    const node = new y.Node('probe');
    collected.transact(() => collected.get('probe').insert(0, [node]));
    collected.transact(() => node.insert(0, 'ab'));
    collected.transact(() => collected.get('probe').delete(0, 1));
    const structs = collected.store.clients.get(collected.clientID) || [];
    sample(
      'GC',
      structs.find(struct => !(struct instanceof y.Item)),
    );
    sample('RelativePosition', new y.RelativePosition(null, null, null, 0));
    sample('Skip', new y.Skip(y.createID(1, 0), 1));
    sample('decodeUpdate', y.decodeUpdate(y.encodeStateAsUpdate(doc)));
    // Development builds only (the contract test runs it in CI): it costs
    // the repair's code and scratch documents in every entry.
    if (__DEV__) {
      probeGapLoad(y, sample, found);
    }
    probeCopies(y, doc, root, undoManager, PROBE_ORIGIN, found);
    undoManager.undo();
    undoManager.clear();
  } catch (error) {
    threw = error;
  } finally {
    try {
      if (um.destroy) {
        um.destroy();
      }
      doc.destroy();
      collected.destroy();
    } catch (error) {
      threw = threw || error;
    }
  }
  // After a throw, what was reached is checked (it usually names the
  // cause), then the throw itself; otherwise every kind must have been made.
  if (threw !== null) {
    found.push(
      `probe threw: ${threw instanceof Error ? threw.message : String(threw)}`,
    );
    return;
  }
  for (const kind of Object.keys(members)) {
    // The gap probe makes these (development builds only, see above).
    if (!__DEV__ && GAP_PROBE_KINDS.has(kind)) {
      continue;
    }
    if (!sampled.has(kind)) {
      found.push(`${kind} (not made)`);
    }
  }
  for (const [emitter, names] of Object.entries(YJS_EVENTS)) {
    for (const name of names) {
      if (!events.has(`${emitter}@${name}`)) {
        found.push(`${emitter}@${name}`);
      }
    }
  }
}

/**
 * What the copy fix-up of paired format runs relies on (see Ident's
 * beforeObservers), checked on the probe's document: a format item restored
 * by an undo is a copy whose content shares its original's value object and
 * whose original's `redone` names it; and content a `beforeObserverCalls`
 * listener puts into an item the transaction inserted is what the
 * transaction's update carries. Each failure is named in `found`.
 */
export const YJS_BEHAVIOURS = {
  copyRedone: "UndoManager: a restored item is the original's redone",
  copyRedoneAtObservers:
    "UndoManager: the original's redone names its copy when beforeObserverCalls runs",
  copyRedoneWhenUndoReturns:
    "UndoManager: the original's redone names its copy when the undo call returns, inside an app's transaction",
  copySharesValue: 'ContentFormat#copy: a copy shares the value object',
  fixBeforeCaptureAndGc:
    'Doc@beforeObserverCalls: runs before the UndoManager captures and before gc',
  fixBeforeEncoding:
    'Doc@beforeObserverCalls: runs before the update is encoded',
  freshDecodedValues: 'decodeUpdate: decoded format values are fresh objects',
  freshEqualDecodedValues:
    'decodeUpdate: equal format values decode to separate objects, every time',
  originByConstructor:
    'UndoManager: tracks an origin by its constructor, and only so',
} as const;

function probeCopies(
  y: YjsExports,
  doc: Doc,
  root: YNode,
  undoManager: UndoManager,
  origin: object,
  found: string[],
): void {
  // The format item the probe wrote over "a", with an array value.
  let original: Item | null = null;
  for (let it = root._start; it !== null; it = it.right) {
    if (
      !it.deleted &&
      it.content instanceof y.ContentFormat &&
      it.content.key === 'probe' &&
      Array.isArray(it.content.value)
    ) {
      original = it;
      break;
    }
  }
  if (original === null) {
    found.push(YJS_BEHAVIOURS.copySharesValue);
    return;
  }
  const value = (original.content as ContentFormat).value;
  doc.transact(() => root.format(0, 1, {probe: null}), origin);
  // The fix-up runs in beforeObserverCalls and finds an undo's copy through
  // its original's `redone`: that must name the copy by then. A read inside
  // an app's transaction repairs pending copies first (Reader#$reading), so
  // it must name the copy as soon as the undo call returns, too (in the
  // transaction the undo joins). Nothing relies on it earlier: no code of
  // the binding runs while Yjs integrates the copy.
  const restored: Item = original;
  let redoneAtObservers = false;
  let redoneOnReturn = false;
  const atObservers = (tr: Transaction) => {
    const r = restored.redone;
    redoneAtObservers = r !== null && tr.insertSet.hasId(r);
  };
  doc.on('beforeObserverCalls', atObservers);
  try {
    doc.transact(tr => {
      undoManager.undo();
      const r = restored.redone;
      redoneOnReturn = r !== null && tr.insertSet.hasId(r);
    });
  } finally {
    doc.off('beforeObserverCalls', atObservers);
  }
  if (!redoneAtObservers) {
    found.push(YJS_BEHAVIOURS.copyRedoneAtObservers);
  }
  if (!redoneOnReturn) {
    found.push(YJS_BEHAVIOURS.copyRedoneWhenUndoReturns);
  }
  const redone = original.redone;
  const copy = redone === null ? null : doc.store.getItem(redone);
  if (!(copy instanceof y.Item) || copy.deleted) {
    found.push(YJS_BEHAVIOURS.copyRedone);
  } else if (
    !(copy.content instanceof y.ContentFormat) ||
    copy.content.value !== value
  ) {
    found.push(YJS_BEHAVIOURS.copySharesValue);
  }
  // A listener's new content reaches the update.
  let fixing = true;
  let update: Uint8Array | null = null;
  const fix = (tr: Transaction) => {
    if (!fixing) {
      return;
    }
    y.iterateStructsByIdSet(tr, tr.insertSet, s => {
      if (
        s instanceof y.Item &&
        s.content instanceof y.ContentFormat &&
        s.content.key === 'probeFix' &&
        s.content.value !== null
      ) {
        s.content = new y.ContentFormat('probeFix', 'fixed');
      }
    });
  };
  const onUpdate = (u: Uint8Array) => {
    if (fixing) {
      update = u;
    }
  };
  doc.on('beforeObserverCalls', fix);
  doc.on('update', onUpdate);
  try {
    doc.transact(() => root.format(1, 1, {probeFix: 'raw'}), origin);
  } finally {
    fixing = false;
    doc.off('beforeObserverCalls', fix);
    doc.off('update', onUpdate);
  }
  let carried = false;
  if (update !== null) {
    for (const struct of y.decodeUpdate(update).structs) {
      if (
        struct instanceof y.Item &&
        struct.content instanceof y.ContentFormat &&
        struct.content.key === 'probeFix' &&
        struct.content.value === 'fixed'
      ) {
        carried = true;
      }
    }
  }
  if (!carried) {
    found.push(YJS_BEHAVIOURS.fixBeforeEncoding);
  }
  // A decoded end is a fresh array, never the sender's object (the fix-up
  // tells an undo's copy from a received end by the shared value).
  const decoded = y.decodeUpdate(y.encodeStateAsUpdate(doc)).structs;
  for (const struct of decoded) {
    if (
      struct instanceof y.Item &&
      struct.content instanceof y.ContentFormat &&
      struct.content.value === value
    ) {
      found.push(YJS_BEHAVIOURS.freshDecodedValues);
      break;
    }
  }
  // Nor two equal decoded arrays one object (a decoder that interns values
  // would make two received ends look like one end and its undo copy), in
  // one update or across two decodes of it.
  probeEqualDecodes(y, found);
  probeObserverOrder(y, origin, found);
  // The layout record's origin is an instance of a private class: an
  // UndoManager tracks an origin by identity or by its constructor, so one
  // that tracks plain objects does not capture it, and one that tracks the
  // class does (the check that the matching rule is what it was).
  class Private {}
  const byObject = new y.UndoManager(root, {
    captureTimeout: 0,
    trackedOrigins: new Set<unknown>([Object]),
  });
  const byClass = new y.UndoManager(root, {
    captureTimeout: 0,
    trackedOrigins: new Set<unknown>([Private]),
  });
  try {
    doc.transact(() => root.setAttr('probeOrigin', 1), new Private());
    if (byObject.canUndo() || !byClass.canUndo()) {
      found.push(YJS_BEHAVIOURS.originByConstructor);
    }
  } finally {
    byObject.destroy();
    byClass.destroy();
  }
}

/** Format values of key `key` in a decoded update, in order. */
function decodedValues(y: YjsExports, update: Uint8Array, key: string) {
  const out: unknown[] = [];
  for (const struct of y.decodeUpdate(update).structs) {
    if (
      struct instanceof y.Item &&
      struct.content instanceof y.ContentFormat &&
      struct.content.key === key
    ) {
      out.push(struct.content.value);
    }
  }
  return out;
}

function probeEqualDecodes(y: YjsExports, found: string[]): void {
  const doc = new y.Doc({gc: false, guid: PROBE_GUID});
  try {
    const root = doc.get('probe');
    doc.transact(() => {
      root.insert(0, 'abcd');
      root.format(0, 1, {probeEq: [1]});
      root.format(2, 1, {probeEq: [1]});
    });
    const update = y.encodeStateAsUpdate(doc);
    const once = decodedValues(y, update, 'probeEq').filter(Array.isArray);
    const twice = decodedValues(y, update, 'probeEq').filter(Array.isArray);
    if (
      once.length < 2 ||
      once[0] === once[1] ||
      twice.length !== once.length ||
      twice.some((v, i) => v === once[i])
    ) {
      found.push(YJS_BEHAVIOURS.freshEqualDecodedValues);
    }
  } finally {
    doc.destroy();
  }
}

/**
 * The fix-up must change an undo's copies before an UndoManager captures the
 * transaction (it records what the transaction inserted, by id) and before
 * gc replaces the content of what the transaction deleted: beforeObserverCalls
 * runs first, with every deleted item's content still there.
 */
function probeObserverOrder(
  y: YjsExports,
  origin: object,
  found: string[],
): void {
  const doc = new y.Doc({gc: true, guid: PROBE_GUID});
  const root = doc.get('probe');
  doc.transact(() => {
    root.insert(0, 'ab');
    root.format(0, 1, {probeGc: true});
  });
  let gone: Item | null = null;
  for (let it = root._start; it !== null; it = it.right) {
    if (it.content instanceof y.ContentFormat && it.content.key === 'probeGc') {
      gone = it;
    }
  }
  const undoManager = new y.UndoManager(root, {
    captureTimeout: 0,
    trackedOrigins: new Set<unknown>([origin]),
  });
  const order: string[] = [];
  let contentAtFix = false;
  const fix = () => {
    order.push('fix');
    contentAtFix =
      gone !== null && gone.deleted && gone.content instanceof y.ContentFormat;
  };
  const capture = () => order.push('capture');
  const cleanup = () => order.push('cleanup');
  doc.on('beforeObserverCalls', fix);
  doc.on('afterTransactionCleanup', cleanup);
  undoManager.on('stack-item-added', capture);
  try {
    // The transaction deletes the format item (as a format change does).
    doc.transact(tr => {
      if (gone !== null) {
        gone.delete(tr);
      }
    }, origin);
  } finally {
    doc.off('beforeObserverCalls', fix);
    doc.off('afterTransactionCleanup', cleanup);
    undoManager.off('stack-item-added', capture);
    undoManager.destroy();
    doc.destroy();
  }
  if (
    !contentAtFix ||
    order[0] !== 'fix' ||
    order.indexOf('capture') < order.indexOf('fix') ||
    order.indexOf('cleanup') < order.indexOf('fix')
  ) {
    found.push(YJS_BEHAVIOURS.fixBeforeCaptureAndGc);
  }
}

/** What the check found, once per module; undefined until it ran. */
let verdict: readonly string[] | undefined;
/** How many times the check ran (YjsContract.test). */
let probeRuns = 0;

/** @internal How many times this module ran the check. */
export function getYjsProbeRuns(): number {
  return probeRuns;
}

/**
 * Throw a {@link YUnsupportedYjsError} unless the @y/y the app loaded
 * provides the contract. Probes once per module; later calls reuse the
 * verdict.
 */
export function assertSupportedYjs(): void {
  if (verdict === undefined) {
    probeRuns++;
    verdict = Object.freeze(probeYjs());
  }
  if (verdict.length > 0) {
    // A copy: what a caller does with the error's data cannot change the
    // verdict.
    throw new YUnsupportedYjsError({
      found: verdict.slice(),
      reason: 'changed-internals',
      supported: SUPPORTED_YJS_VERSION,
    });
  }
}

/**
 * Throw a {@link YUnsupportedYjsError} unless `doc` is a `Y.Doc` of the
 * @y/y this module loaded and `root`, when given, a `Y.Node` of it.
 */
export function assertOwnYjsDoc(doc: unknown, root?: unknown): void {
  const other: string[] = [];
  if (!(doc instanceof Doc)) {
    other.push('Y.Doc');
  } else if (root !== undefined && !(root instanceof YNode)) {
    other.push('Y.Node (the root)');
  }
  if (other.length > 0) {
    throw new YUnsupportedYjsError({
      found: other,
      reason: 'other-copy',
      supported: SUPPORTED_YJS_VERSION,
    });
  }
}
