/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {blockIdState} from '@lexical/extension';
import {ContentType, createID, Item, type Node as YNode} from '@y/y';
import {
  $getNodeByKey,
  $getState,
  $getWritableNodeState,
  $isElementNode,
  $isRootNode,
  $isTextNode,
  $setState,
  type ElementNode,
  type LexicalNode,
  NODE_STATE_DIRECT,
  type NodeKey,
} from 'lexical';

import {pushAll} from './Arrays';
import {
  $isGroupNode,
  type Attrs,
  getGroupSpec,
  GROUP_FIELD_PREFIX,
  GROUP_KEY,
  type GroupSpec,
  klassOf,
  LEVEL_KEY,
  OUTER_KEY,
  STATE_PREFIX,
  TYPE_KEY,
  WRAPPER_FIELDS_KEY,
} from './Schema';
import {isShownEnd, shownAttrs} from './Seen';
import {$inNamedSlot} from './Slots';
import {type CS, type State, typeOf, type Unit, type UnitKind} from './State';

// Block ids (BlockIdExtension's), as the binding reads them: the grammar of
// derived ids, the index of which blocks store which id, and the settlement
// that gives each block the id it shows. The reader, the writer and the
// binding call in here at the points where a block is read, placed, written
// or checked; nothing else knows these rules.
//
// Invariant: the id a block shows is a function of the document alone: its
// stored id if no block before it in document order shows that id, else the
// id derived from its own Yjs item (see derivedBlockId), else that id
// followed by `_d`s (see BlockIdSettler#$shownId). Why: every client with
// BlockIdExtension and every fresh reader of the same configuration then
// shows the same ids, whatever order it saw changes in, and no two blocks
// show one id.
//
// Invariant: settling changes what the editor shows, never the document.
// Why: only users' own edits write; the next write of a block stores the id
// it shows.
//
// Invariant: only identified blocks outside named slots are settled (see
// BlockIdSettler#$isSettled), and each group level owns its id: a group that
// is not an identified block keeps none, nor one a group it is inside holds
// (see $withoutOuterId), and a block that is not one shows no derived id (a
// wrapper item included, see BlockIdSettler#$placeUnit). Why: an id names
// one block, blocks in a named slot have no document order every reader
// computes the same way, and the client that made a block gave it an id
// only if it is an identified block, so its readers must not either.
//
// Invariant: a derived id names the Yjs item it derives from, in one grammar
// (see formatDerivedId and parseDerivedId). Why: the block that derives an id
// is found from the id alone (see BlockIdSettler#$derivingBlock).
//
// Invariant: settling covers the ids a change touched (BlockIdIndex's
// `touchedIds`), never the whole document. Why: a keystroke costs what it
// touched, however many ids the document repeats.
//
// Invariant: where the editor has no BlockIdExtension (`State#blockIds` is
// null), nothing reads or sets `blockIdState`, and a stored `blockId` key is
// NodeState like any other (see $dropLevelId). Why: Lexical allows one
// StateConfig per key on a node class, and an app may define its own
// `blockId` state; touching BlockIdExtension's there makes every later use
// of the app's throw.

// ---------------------------------------------------------------------------
// The derived-id grammar: y<client>_<clock>[_l|_g<level>|_w<level>](_d)*

/**
 * The block id derived from a marker or a stored node, the same on every
 * client and every read (see implicitBlockId): `y`, the item's client, `_`
 * and its clock, in base 36.
 */
export function derivedBlockId(item: Item): string {
  return itemBlockId(item.id.client, item.id.clock);
}

/** `y`, a client, `_` and a clock, in base 36 (see derivedBlockId). */
function itemBlockId(client: number, clock: number): string {
  return 'y' + client.toString(36) + '_' + clock.toString(36);
}

/**
 * The derived id of a stored node (see derivedBlockId), from its own item;
 * a list's ends in `_g` (a line without a marker that starts with it
 * derives its id from that item too, see implicitBlockId).
 */
function storedDerivedId(node: LexicalNode, item: Item): string {
  return derivedBlockId(item) + ($isGroupNode(node) ? groupSuffix(0) : '');
}

/** The suffix of a group's derived id (see BlockIdSettler#$derivedIdOf). */
export function groupSuffix(level: number): string {
  return level === 0 ? '_g' : '_g' + level;
}

/**
 * The suffix of a wrapper item's derived id (see
 * BlockIdSettler#$derivedIdOf).
 */
export function wrapperSuffix(level: number): string {
  return level === 0 ? '_w' : '_w' + level;
}

/**
 * The suffix of the derived id of a line without a marker whose first item
 * is a node stored in the line (see implicitBlockId).
 */
const EMBEDDED_SUFFIX = '_l';

/**
 * What a derived id takes, once for every block before it that shows the id
 * without it (see BlockIdSettler#$shownId).
 */
const REPEAT_SUFFIX = '_d';

/**
 * The block id of a line without a marker (text that concurrent edits left
 * without one), the same on every client and on every read: `y`, the client
 * of its first character's Yjs item, `_` and that item's clock, in base 36,
 * and `_l` when that item is a node stored in the line (which derives its
 * own id from it, see storedDerivedId). A block id is 1 to 64 characters of
 * the base64url alphabet. A write that gives the line a marker stores the
 * id the line has, so it stays.
 */
function implicitBlockId(start: Item | null, stop: Item | null): string | null {
  for (let it = start; it !== null && it !== stop; it = it.right) {
    if (!it.deleted && it.countable) {
      return (
        derivedBlockId(it) +
        (it.content instanceof ContentType ? EMBEDDED_SUFFIX : '')
      );
    }
  }
  return null;
}

/**
 * The derived id of a line without a marker (see implicitBlockId): its
 * content runs from the end of the unit before it to the node after it.
 */
function implicitIdOf(unit: Unit): string | null {
  const units = unit.cs.units;
  const i = units.indexOf(unit);
  if (i < 0) {
    return null;
  }
  const prev = i > 0 ? units[i - 1].end : null;
  if (i > 0 && prev === null) {
    return null;
  }
  const next = i + 1 < units.length ? units[i + 1].end : null;
  return implicitBlockId(prev === null ? unit.cs.y._start : prev.right, next);
}

/**
 * The parts of a derived block id (see formatDerivedId): the Yjs item it
 * derives from, how a block derives it from that item, and how many
 * REPEAT_SUFFIXes follow.
 */
export type DerivedId = {
  readonly client: number;
  readonly clock: number;
  /**
   * '': a line's marker, a stored node's item, or the first character of a
   * line without a marker; 'l': the first item of a line without a marker,
   * a node stored in the line (see implicitBlockId); 'g': a group's first
   * line, or its own item for a group stored as a node (see groupSuffix);
   * 'w': a wrapper item's nested group's first line (see wrapperSuffix).
   */
  readonly kind: '' | 'l' | 'g' | 'w';
  /** The group level of a 'g' or 'w' id, 0 the outermost; 0 otherwise. */
  readonly level: number;
  readonly repeats: number;
};

/** A derived block id from its parts (see parseDerivedId for the inverse). */
export function formatDerivedId(id: DerivedId): string {
  return (
    itemBlockId(id.client, id.clock) +
    (id.kind === 'g'
      ? groupSuffix(id.level)
      : id.kind === 'w'
        ? wrapperSuffix(id.level)
        : id.kind === 'l'
          ? EMBEDDED_SUFFIX
          : '') +
    REPEAT_SUFFIX.repeat(id.repeats)
  );
}

/**
 * The parts of a derived block id, and `base`, the id without its repeats as
 * written; null for a string of another form. A string formatDerivedId does
 * not write parses too (a level written `0`, a number with leading zeros), so
 * only `base` names it.
 */
export function parseDerivedId(
  id: string,
): (DerivedId & {readonly base: string}) | null {
  const m =
    /^(y([0-9a-z]+)_([0-9a-z]+)(?:_([gw])([0-9]*)|_(l))?)((?:_d)*)$/.exec(id);
  if (m === null) {
    return null;
  }
  return {
    base: m[1],
    client: parseInt(m[2], 36),
    clock: parseInt(m[3], 36),
    kind: m[4] === 'g' || m[4] === 'w' ? m[4] : m[6] !== undefined ? 'l' : '',
    level: m[5] === undefined || m[5] === '' ? 0 : parseInt(m[5], 10),
    repeats: m[7].length / REPEAT_SUFFIX.length,
  };
}

// ---------------------------------------------------------------------------
// The index of stored ids

/**
 * Block ids as stored, for the nodes a read gave one (see BlockIdSettler):
 * the node's stored id, the nodes per stored id, the ids whose claimants
 * changed since they were last settled, and the ids several blocks claim
 * (store, or store and derive: a block that changes while holding one has it
 * settled again, see $touchChanged). Kept where the editor has block ids
 * (`config.blockIds`, see State).
 */
export class BlockIdIndex {
  readonly storedIdOf = new Map<NodeKey, string>();
  readonly holdersOf = new Map<string, Set<NodeKey>>();
  readonly touchedIds = new Set<string>();
  readonly repeatedIds = new Set<string>();
  constructor(private readonly config: {readonly blockIds: unknown}) {}

  /** Note the block id a read found stored for a node (see storedIdOf). */
  noteStoredId(key: NodeKey, id: unknown): void {
    if (this.config.blockIds === null) {
      return;
    }
    const next = typeof id === 'string' ? id : undefined;
    const prev = this.storedIdOf.get(key);
    if (prev === next) {
      return;
    }
    if (prev !== undefined) {
      const set = this.holdersOf.get(prev);
      if (set !== undefined) {
        set.delete(key);
        if (set.size === 0) {
          this.holdersOf.delete(prev);
        }
      }
      this.touchedIds.add(prev);
    }
    if (next === undefined) {
      this.storedIdOf.delete(key);
      return;
    }
    this.storedIdOf.set(key, next);
    let set = this.holdersOf.get(next);
    if (set === undefined) {
      set = new Set();
      this.holdersOf.set(next, set);
    }
    set.add(key);
    if (set.size > 1) {
      this.repeatedIds.add(next);
    }
    this.touchedIds.add(next);
  }
}

// ---------------------------------------------------------------------------
// Each group level owns its id

/** No block ids (see $withoutOuterId). */
export const NO_IDS: ReadonlySet<string> = new Set();

/**
 * Leave out of a group's fields (`$`: its NodeState) a block id that a group
 * it is inside holds (`outerIds`): each group level owns its state, and a
 * block id names one block. The binding's transform on groups does the same
 * in the editor (see $canonicalizeGroup), so the author of an edit and its
 * readers agree.
 */
function $withoutOuterId(
  fields: Attrs,
  outerIds: ReadonlySet<string>,
): boolean {
  const st = fields.$;
  if (
    outerIds.size === 0 ||
    st === null ||
    typeof st !== 'object' ||
    Array.isArray(st)
  ) {
    return false;
  }
  const id = (st as Attrs)[blockIdState.key];
  if (typeof id === 'string' && outerIds.has(id)) {
    const rest: Attrs = {...(st as Attrs)};
    delete rest[blockIdState.key];
    if (Object.keys(rest).length > 0) {
      fields.$ = rest;
    } else {
      delete fields.$;
    }
    return true;
  }
  return false;
}

/** The block id in a group's fields (see $withoutOuterId), if any. */
function groupBlockId(fields: Attrs): string | null {
  const st = fields.$;
  const id =
    st !== null && typeof st === 'object' && !Array.isArray(st)
      ? (st as Attrs)[blockIdState.key]
      : undefined;
  return typeof id === 'string' ? id : null;
}

/** The ids of the groups a nested group is inside, its own added. */
export function innerBlockIds(
  outerIds: ReadonlySet<string>,
  fields: Attrs,
): ReadonlySet<string> {
  const id = groupBlockId(fields);
  return id === null || outerIds.has(id)
    ? outerIds
    : new Set([...outerIds, id]);
}

/**
 * The ids of the groups a nested group is inside, with the id `group` shows
 * added (see Reader#$buildGroups); none without BlockIdExtension
 * (`isIdentified` null).
 */
export function $innerBlockIdsOf(
  outerIds: ReadonlySet<string>,
  group: ElementNode,
  isIdentified: ((block: LexicalNode) => boolean) | null,
): ReadonlySet<string> {
  if (isIdentified === null) {
    return outerIds;
  }
  const id = $getState(group, blockIdState);
  return typeof id === 'string' ? new Set([...outerIds, id]) : outerIds;
}

/**
 * A group's fields as stored on its items (see Writer#$levelFields): without
 * any block id when the group is not an identified block (a nested list), or
 * without one a group it is inside holds (`outerIds`, see $withoutOuterId).
 * Returns whether it left one out. Without BlockIdExtension (`isIdentified`
 * null) the fields are stored as they are.
 */
export function $withoutLevelId(
  fields: Attrs,
  group: ElementNode,
  outerIds: ReadonlySet<string>,
  isIdentified: ((block: LexicalNode) => boolean) | null,
): boolean {
  if (isIdentified === null) {
    return false;
  }
  return $withoutOuterId(
    fields,
    groupBlockId(fields) !== null && !isIdentified(group)
      ? new Set([groupBlockId(fields)!])
      : outerIds,
  );
}

/**
 * The editor's side of $withoutLevelId (see $canonicalizeGroup): a group that
 * is not an identified block (a nested list) keeps no block id, nor one a
 * group it is inside holds. Without BlockIdExtension (`isIdentified` null) it
 * does nothing: the editor may hold an app's own `blockId` state there.
 */
export function $dropLevelId(
  node: ElementNode,
  spec: GroupSpec,
  isIdentified: ((block: LexicalNode) => boolean) | null,
): void {
  if (isIdentified === null) {
    return;
  }
  const id = $getState(node, blockIdState);
  if (typeof id === 'string' && !isIdentified(node)) {
    $setBlockId(node, undefined);
  } else if (typeof id === 'string') {
    for (
      let w = node.getParent(), g = w === null ? null : w.getParent();
      w !== null &&
      g !== null &&
      spec.items.includes(klassOf(w)) &&
      getGroupSpec(klassOf(g)) === spec;
      w = g.getParent(), g = w === null ? null : w.getParent()
    ) {
      if ($getState(g, blockIdState) === id) {
        $setBlockId(node, undefined);
        break;
      }
    }
  }
}

/**
 * Set a node's block id (`undefined`: none). A node made from JSON keeps the
 * JSON values of state keys its type did not know yet, and keeps them beside
 * the values parsed from them later (until the node is next cloned), and
 * Lexical reads the JSON value again once the parsed one is the default: a
 * node made from JSON storing an id, in an update where its type met
 * `blockIdState` only afterwards, kept the id that $setState removed (the
 * first lists a fresh reader makes). The JSON value is parsed, and dropped,
 * first.
 */
function $setBlockId(node: LexicalNode, id: string | undefined): void {
  $getState(node, blockIdState);
  const state = $getWritableNodeState(node);
  const json = state.unknownState;
  if (json !== undefined && blockIdState.key in json) {
    const rest = {...json};
    delete rest[blockIdState.key];
    state.unknownState = Object.keys(rest).length > 0 ? rest : undefined;
  }
  $setState(node, blockIdState, id);
}

// ---------------------------------------------------------------------------
// Settlement

/**
 * The block ids a reader shows (see Reader): what it derives and notes while
 * it places blocks, and the settlement its outermost entry point runs (see
 * $settleIds). Settled ids go back to the index (see BlockIdIndex).
 */
export class BlockIdSettler {
  /**
   * Nodes a read placed inside a line (a block decorator written into a
   * paragraph without the normalization) that store no block id: they get
   * the id derived from their item once in place, if identified blocks (see
   * $settleIds), as nodes stored in a container do (see $placeUnit).
   */
  private readonly inlineStored = new Set<NodeKey>();
  /**
   * Paragraphs a read made around a run of inline content in a shadow root
   * (see noteInlineRun): they get the id derived from the run's first item
   * once in place, if identified blocks (see $settleIds).
   */
  private readonly inlineRuns = new Set<NodeKey>();
  constructor(readonly state: State) {}

  /**
   * A unit a read placed (see Reader#$commitUnits): whether its block (a
   * line, a stored node, the groups an item is in) keeps the id it derives
   * is known once it is in place. Each kind keeps its own rule: a line's
   * derived id goes where it is not an identified block, a stored node
   * derives one where it stores none, and a group, or a wrapper item, keeps
   * none it does not store where it is not an identified block.
   */
  $placeUnit(u: Unit): void {
    const isIdentified = this.state.blockIds;
    if (isIdentified === null || u.key === null) {
      return;
    }
    this.$placeLineId(u, u.key, isIdentified);
    this.$placeStoredId(u, u.key, isIdentified);
    this.$placeGroupIds(u, u.key, isIdentified);
  }

  /**
   * A derived id (a line without a marker, or whose marker stores none) is
   * for identified blocks only (known once the line is in place).
   */
  private $placeLineId(
    u: Unit,
    key: NodeKey,
    isIdentified: (node: LexicalNode) => boolean,
  ): void {
    if (
      u.kind === 'implicit' ||
      (u.kind === 'line' &&
        u.end !== null &&
        shownAttrs(u.end, this.state.hidden)[
          STATE_PREFIX + blockIdState.key
        ] === undefined)
    ) {
      const line = $getNodeByKey(key);
      if (
        line !== null &&
        $getState(line, blockIdState) !== undefined &&
        !isIdentified(line)
      ) {
        $setBlockId(line, undefined);
      }
    }
  }

  /**
   * A stored node that stores no id has one derived from its item, if it is
   * an identified block (known once it is in place).
   */
  private $placeStoredId(
    u: Unit,
    key: NodeKey,
    isIdentified: (node: LexicalNode) => boolean,
  ): void {
    if (u.kind !== 'node' || u.end === null) {
      return;
    }
    const node = $getNodeByKey(key);
    const y = typeOf(u.end);
    this.state.ids.noteStoredId(
      key,
      y.getAttr(STATE_PREFIX + blockIdState.key),
    );
    if (
      node !== null &&
      y.getAttr(STATE_PREFIX + blockIdState.key) === undefined
    ) {
      const want = isIdentified(node)
        ? storedDerivedId(node, u.end)
        : undefined;
      if ($getState(node, blockIdState) !== want) {
        $setBlockId(node, want);
      }
      this.noteDerived(want ?? null);
    }
  }

  /**
   * So is a group's (known once it is in place): a group that is not an
   * identified block (a nested list) keeps no block id, which an item's
   * marker can carry from another level or another group after concurrent
   * edits (see $withoutOuterId). And a wrapper item's (the item holding a
   * nested group): the id it derives (see withDerivedWrapperId) is for an
   * identified block only, as a line's is; one its nested items store is
   * its author's and stays.
   */
  private $placeGroupIds(
    u: Unit,
    key: NodeKey,
    isIdentified: (node: LexicalNode) => boolean,
  ): void {
    if (u.sig === '') {
      return;
    }
    const line = $getNodeByKey(key);
    let g = line === null ? null : line.getParent();
    while ($isElementNode(g) && getGroupSpec(klassOf(g)) !== null) {
      if ($getState(g, blockIdState) !== undefined && !isIdentified(g)) {
        $setBlockId(g, undefined);
      }
      const w: ElementNode | null = g.getParent();
      g = w === null ? null : w.getParent();
      if (
        w !== null &&
        $isElementNode(g) &&
        getGroupSpec(klassOf(g)) !== null &&
        $getState(w, blockIdState) !== undefined &&
        !isIdentified(w) &&
        typeof $storedIdNow(this.state, w) !== 'string'
      ) {
        $setBlockId(w, undefined);
      }
    }
  }

  /**
   * The id a line a read parses derives from its Yjs identity, where the
   * editor has block ids: from its marker, or, without one, from its first
   * item (see implicitBlockId).
   */
  derivedLineId(line: {
    readonly kind: UnitKind;
    readonly end: Item | null;
    readonly startItem: Item | null;
    readonly stop: Item | null;
  }): string | null {
    return this.state.blockIds === null
      ? null
      : line.kind === 'implicit'
        ? implicitBlockId(line.startItem, line.stop)
        : derivedBlockId(line.end!);
  }

  /**
   * A line's marker attributes with the id it derives (see derivedLineId),
   * when they store none: the same on every reader, and stored by the next
   * write of the line. Whether it keeps it is known once it is in place
   * (see $placeUnit).
   */
  withDerivedLineId(attrs: Attrs, derivedId: string | null): Attrs {
    if (
      derivedId !== null &&
      attrs[STATE_PREFIX + blockIdState.key] === undefined
    ) {
      attrs = {...attrs, [STATE_PREFIX + blockIdState.key]: derivedId};
      this.noteDerived(derivedId);
    }
    return attrs;
  }

  /**
   * A line read again in place (see Reader#$readLineInPlace): the id its
   * marker stores goes to the index, and its marker attributes get the id it
   * derives when they store none, as a line placed anew does (see
   * withDerivedLineId). Whether it keeps that id is known once the
   * attributes are applied (see $placeUnit), which can change whether it is
   * an identified block: a quote in a cell that comes to hold paragraphs is
   * none, and kept an id that a fresh reader does not show.
   */
  $lineIdInPlace(line: ElementNode, attrs: Attrs, end: Item): Attrs {
    this.state.ids.noteStoredId(
      line.getKey(),
      attrs[STATE_PREFIX + blockIdState.key],
    );
    return this.withDerivedLineId(
      attrs,
      this.state.blockIds === null ? null : derivedBlockId(end),
    );
  }

  /**
   * A wrapper item's fields (`$`: its NodeState) get the id it derives from
   * its nested group's first item (`firstDerived`) and its level when they
   * store none. Whether it keeps that id is known once it is in place: an
   * item that is not an identified block keeps none, as on the client that
   * made it (see $placeUnit). Returns the id they store.
   */
  withDerivedWrapperId(
    fields: Attrs,
    firstDerived: string | null,
    level: number,
  ): unknown {
    const wst = fields.$;
    const wstObj =
      wst !== null && typeof wst === 'object' && !Array.isArray(wst)
        ? (wst as Attrs)
        : null;
    const wrapperStoredId =
      wstObj === null ? undefined : wstObj[blockIdState.key];
    if (
      this.state.blockIds !== null &&
      wrapperStoredId === undefined &&
      firstDerived !== null
    ) {
      fields.$ = {
        ...(wstObj || {}),
        [blockIdState.key]: firstDerived + wrapperSuffix(level),
      };
      this.noteDerived(firstDerived + wrapperSuffix(level));
    }
    return wrapperStoredId;
  }

  /**
   * A group's fields, where the editor has block ids: without a block id
   * that a group it is inside holds (`outerIds`, see $withoutOuterId), and
   * with the id it derives from its first item (`derivedId`, an identified
   * group only: see $placeUnit) when its items store none (as stored
   * without BlockIdExtension). Returns the id they store: in the index of who
   * stores what, the group holds the id as stored (see $storedIdNow), and
   * settling gives it the id it shows (its derived id when the outer group
   * shows that one), like any block that repeats an id, on every reader.
   */
  withGroupId(
    fields: Attrs,
    outerIds: ReadonlySet<string>,
    derivedId: string | null,
  ): string | undefined {
    const storedId = groupBlockId(fields) ?? undefined;
    if (this.state.blockIds === null) {
      return storedId;
    }
    $withoutOuterId(fields, outerIds);
    if (derivedId !== null) {
      const st = fields.$;
      const stObj =
        st !== null && typeof st === 'object' && !Array.isArray(st)
          ? (st as Attrs)
          : {};
      if (stObj[blockIdState.key] === undefined) {
        fields.$ = {...stObj, [blockIdState.key]: derivedId + groupSuffix(0)};
        this.noteDerived(derivedId + groupSuffix(0));
      }
    }
    return storedId;
  }

  /**
   * A stored node's attributes, with the block id derived from its item
   * (see derivedBlockId) when it stores none and is an identified block.
   * `placed`: the node is where the read shows it; otherwise (a read that
   * places it next) a derived id it has is kept, and $placeUnit decides
   * once it is in place.
   */
  $withDerivedNodeId(
    node: LexicalNode,
    y: YNode,
    attrs: Attrs,
    placed: boolean,
  ): Attrs {
    const isIdentified = this.state.blockIds;
    const k = STATE_PREFIX + blockIdState.key;
    if (isIdentified === null || attrs[k] !== undefined || y._item === null) {
      return attrs;
    }
    const derived = storedDerivedId(node, y._item);
    const keep = placed
      ? node.isAttached() && isIdentified(node)
      : $getState(node, blockIdState) === derived;
    if (keep) {
      this.noteDerived(derived);
    }
    return keep ? {...attrs, [k]: derived} : attrs;
  }

  /**
   * A paragraph a read made around a run of inline content in a shadow root
   * (see Reader's $inShadowRoot), and the run's first item; null: it is no
   * longer one. It derives its id from that item as a line without a marker
   * does from its first one (see implicitBlockId), the same on every client
   * and every read, and BlockIdExtension has nothing to name.
   */
  noteInlineRun(p: ElementNode, first: Item | null): void {
    const state = this.state;
    if (state.blockIds === null) {
      return;
    }
    const key = p.getKey();
    if (first === null) {
      state.inlineRunStart.delete(key);
    } else {
      state.inlineRunStart.set(key, first);
      this.inlineRuns.add(key);
    }
  }

  /**
   * A stored node a read placed inside a line (see inlineStored): settled
   * once in place when it stores no id.
   */
  noteInlineStored(node: LexicalNode, y: YNode): void {
    if (
      this.state.blockIds !== null &&
      y.getAttr(STATE_PREFIX + blockIdState.key) === undefined
    ) {
      this.inlineStored.add(node.getKey());
    }
  }

  /**
   * Settle the ids a read touched: blocks that store the same id (concurrent
   * edits split a list whose items all store its id, or copied a block's
   * marker), and blocks that store another block's derived id (a block's
   * JSON copied with the id a reader showed).
   *
   * Invariant: every block shows the first id of its own list that no block
   * before it in document order shows (see $shownId): its stored id, then
   * the id derived from its own Yjs identity (see derivedBlockId), then that
   * id followed by `_d`s. Why: every reader shows the same, no two blocks
   * show one id, BlockIdExtension has nothing to name, and the next write of
   * such a block stores the id it shows.
   */
  $settleIds(): void {
    const state = this.state;
    const isIdentified = state.blockIds;
    if (isIdentified === null) {
      state.ids.touchedIds.clear();
      this.inlineStored.clear();
      this.inlineRuns.clear();
      return;
    }
    for (const key of this.inlineStored) {
      const node = $getNodeByKey(key);
      const y = state.yByKey.get(key);
      if (
        node !== null &&
        node.isAttached() &&
        y !== undefined &&
        y._item !== null &&
        y.getAttr(STATE_PREFIX + blockIdState.key) === undefined
      ) {
        const want = isIdentified(node)
          ? storedDerivedId(node, y._item)
          : undefined;
        if ($getState(node, blockIdState) !== want) {
          $setBlockId(node, want);
        }
        this.noteDerived(want ?? null);
      }
    }
    this.inlineStored.clear();
    for (const key of this.inlineRuns) {
      const node = $getNodeByKey(key);
      if (node !== null && node.isAttached()) {
        const want = isIdentified(node)
          ? (this.$derivedIdOf(node) ?? undefined)
          : undefined;
        if ($getState(node, blockIdState) !== want) {
          $setBlockId(node, want);
        }
        this.noteDerived(want ?? null);
      }
    }
    this.inlineRuns.clear();
    // A paragraph a read made that left the document since (its quote was
    // removed) no longer needs its run's first item.
    for (const key of state.inlineRunStart.keys()) {
      const node = $getNodeByKey(key);
      if (node === null || !node.isAttached()) {
        state.inlineRunStart.delete(key);
      }
    }
    $touchChanged(state);
    const pass = newSettlePass();
    // Only the ids whose claimants this update changed: settling costs what
    // the change touched, however many ids the document repeats.
    const ids = new Set(state.ids.touchedIds);
    state.ids.touchedIds.clear();
    // A group's or wrapper item's derived id comes from its first line: a
    // group whose children changed in this read, and the blocks it is the
    // first block of, derive theirs again (or, storing one, are settled).
    const seen = new Set<NodeKey>();
    for (const key of state.refresh) {
      let n: LexicalNode | null = $getNodeByKey(key);
      while (
        $isElementNode(n) &&
        !$isRootNode(n) &&
        n.isAttached() &&
        !seen.has(n.getKey())
      ) {
        seen.add(n.getKey());
        const now = $storedIdNow(state, n);
        const stored =
          state.ids.storedIdOf.get(n.getKey()) ??
          (typeof now === 'string' ? now : undefined);
        if (stored !== undefined) {
          ids.add(stored);
        } else if (
          !state.unitByKey.has(n.getKey()) &&
          isIdentified(n) &&
          !$inNamedSlot(n)
        ) {
          const want = this.$shownId(n, pass);
          const had = $getState(n, blockIdState);
          if (want !== null && had !== want) {
            $setBlockId(n, want);
            if (typeof had === 'string') {
              // Blocks that claim the id it showed may show it now.
              ids.add(had);
            }
          }
          const derived = this.$derivedIdOf(n);
          if (derived !== null) {
            ids.add(derived);
          }
        }
        const parent: ElementNode | null = n.getParent();
        if (
          parent === null ||
          state.csByKey.has(parent.getKey()) ||
          parent.getFirstChild() === null ||
          !parent.getFirstChild()!.is(n)
        ) {
          break;
        }
        n = parent;
      }
    }
    this.$forEachSettled(ids, pass, (node, want) => {
      if ($getState(node, blockIdState) !== want) {
        $setBlockId(node, want);
      }
      return true;
    });
  }

  /**
   * Run `f` on every block that stores one of `ids` (or derives it, see
   * $derivingBlock) with the id it shows (see $shownId). A block that shows
   * another id than the one settled (it falls back to its derived id) has
   * that id settled too, when another block stores it; a block that showed
   * another id before has that id settled too (the blocks that claim it may
   * show it now). `f` returns whether to go on with that id's fallbacks.
   * With `touched`, the ids whose index entries settling found stale are
   * settled too.
   */
  private $forEachSettled(
    ids: Iterable<string>,
    pass: SettlePass,
    f: (node: LexicalNode, want: string, id: string) => boolean,
    touched = true,
  ): void {
    const state = this.state;
    const queue = [...ids];
    const done = new Set<string>();
    while (queue.length > 0 || (touched && state.ids.touchedIds.size > 0)) {
      if (queue.length === 0) {
        // Ids whose index entries settling found stale (see $storers).
        for (const id of state.ids.touchedIds) {
          queue.push(id);
        }
        state.ids.touchedIds.clear();
        pass.claimants.clear();
        pass.shown.clear();
        done.clear();
        continue;
      }
      const id = queue.pop()!;
      if (done.has(id)) {
        continue;
      }
      done.add(id);
      for (const [node, want] of this.$settlement(id, pass)) {
        const had = $getState(node, blockIdState);
        if (
          f(node, want, id) &&
          want !== id &&
          !done.has(want) &&
          this.$storedElsewhere(want, node)
        ) {
          queue.push(want);
        }
        if (typeof had === 'string' && had !== want && !done.has(had)) {
          queue.push(had);
        }
      }
    }
  }

  /** Whether a block other than `node` may store `id`. */
  private $storedElsewhere(id: string, node: LexicalNode): boolean {
    const state = this.state;
    const set = state.ids.holdersOf.get(id);
    if (set !== undefined && (set.size > 1 || !set.has(node.getKey()))) {
      return true;
    }
    const other = state.blockIdHolder === null ? null : state.blockIdHolder(id);
    return other !== null && other.getKey() !== node.getKey();
  }

  /**
   * A read gave a block the derived id `id`: settled with the blocks that
   * store it, if any does (a copy of the id a reader showed, read before
   * the block that derives it was).
   */
  noteDerived(id: string | null): void {
    const state = this.state;
    if (
      id !== null &&
      (state.ids.holdersOf.has(id) ||
        (state.blockIdHolder !== null && state.blockIdHolder(id) !== null))
    ) {
      state.ids.touchedIds.add(id);
    }
  }

  /**
   * The ids among `ids` (and the ids their holders fall back to) whose
   * holders do not show what $settleIds gives them (a check outside an
   * update: it changes no node).
   */
  $unsettled(ids: Iterable<string>): string[] {
    const out = new Set<string>();
    if (this.state.blockIds === null) {
      return [];
    }
    this.$forEachSettled(
      ids,
      newSettlePass(),
      (node, want, id) => {
        const had = $getState(node, blockIdState);
        if (had !== want) {
          out.add(id);
          out.add(want);
          if (typeof had === 'string') {
            out.add(had);
          }
        }
        return true;
      },
      false,
    );
    return [...out];
  }

  /** The blocks that claim `ids` (see $claimants), for the self-check. */
  $claimantsOf(ids: Iterable<string>): LexicalNode[] {
    const pass = newSettlePass();
    const out: LexicalNode[] = [];
    for (const id of ids) {
      pushAll(out, this.$claimants(id, pass));
    }
    return out;
  }

  /**
   * The blocks that store `id`, and the block that derives it, each with
   * the id it shows (see $shownId), once the index of who stores it is
   * brought up to date. An id that several blocks claim is noted as
   * repeated (see BlockIdIndex#repeatedIds).
   */
  private $settlement(id: string, pass: SettlePass): [LexicalNode, string][] {
    const state = this.state;
    const holders = this.$claimants(id, pass);
    const set = state.ids.holdersOf.get(id);
    if (holders.length > 1 || (set !== undefined && set.size > 1)) {
      state.ids.repeatedIds.add(id);
    } else {
      state.ids.repeatedIds.delete(id);
    }
    if (set !== undefined && set.size === 0) {
      state.ids.holdersOf.delete(id);
    }
    const out: [LexicalNode, string][] = [];
    for (const node of holders) {
      const want = this.$shownId(node, pass);
      if (want !== null) {
        out.push([node, want]);
      }
    }
    return out;
  }

  /**
   * The blocks that may show `id`, in document order: those that store it,
   * and the block that derives it (see $derivingBlock).
   */
  private $claimants(id: string, pass: SettlePass): LexicalNode[] {
    let out = pass.claimants.get(id);
    if (out === undefined) {
      out = this.$storers(id);
      const derived = this.$derivingBlock(id);
      if (
        derived !== null &&
        !out.some(n => n.getKey() === derived.getKey()) &&
        this.$isSettled(derived)
      ) {
        out.push(derived);
      }
      if (out.length > 1) {
        const paths = new Map(out.map(n => [n.getKey(), $pathOf(n, pass)]));
        out.sort((a, b) =>
          comparePaths(paths.get(a.getKey())!, paths.get(b.getKey())!),
        );
      }
      pass.claimants.set(id, out);
    }
    return out;
  }

  /** Whether settling gives a block its id (else BlockIdExtension does). */
  private $isSettled(node: LexicalNode): boolean {
    return (
      node.isAttached() && !$inNamedSlot(node) && this.state.blockIds!(node)
    );
  }

  /**
   * The blocks that store `id`, from the index of who stores what (brought
   * up to date where this client rewrote a block since it was read).
   */
  private $storers(id: string): LexicalNode[] {
    const state = this.state;
    const out: LexicalNode[] = [];
    const set = state.ids.holdersOf.get(id);
    if (set !== undefined) {
      for (const key of [...set]) {
        const node = $getNodeByKey(key);
        if (node === null) {
          // Removed (its id is settled again: see $touchChanged).
          state.ids.noteStoredId(key, undefined);
        } else if ($storedIdNow(state, node) !== id) {
          // Rewritten since it was read (by this client's own edit).
          state.ids.noteStoredId(key, $storedIdNow(state, node));
        } else if (this.$isSettled(node)) {
          out.push(node);
        }
      }
    }
    // A block this client's own edits gave the id (not read, so not
    // noted) holds it too.
    const other = state.blockIdHolder === null ? null : state.blockIdHolder(id);
    if (
      other !== null &&
      !(set !== undefined && set.has(other.getKey())) &&
      this.$isSettled(other) &&
      $getState(other, blockIdState) === id &&
      $storedIdNow(state, other) === id
    ) {
      state.ids.noteStoredId(other.getKey(), id);
      out.push(other);
    }
    return out;
  }

  /**
   * The id a block shows: the first of its stored id, its derived id and
   * that id followed by `_d`s that no block before it in document order
   * shows. Each block's depends only on blocks before it, so every reader
   * computes the same, whatever order the ids are settled in.
   */
  private $shownId(node: LexicalNode, pass: SettlePass): string | null {
    const key = node.getKey();
    const known = pass.shown.get(key);
    if (known !== undefined) {
      return known;
    }
    // Not reached again for the same block: only blocks before it are.
    pass.shown.set(key, null);
    const now = $storedIdNow(this.state, node);
    const stored = typeof now === 'string' ? now : undefined;
    let want: string | null = null;
    if (stored !== undefined && !this.$shownBefore(stored, node, pass)) {
      want = stored;
    } else {
      const derived = this.$derivedIdOf(node);
      for (let v = derived; v !== null; v += REPEAT_SUFFIX) {
        if (v !== stored && !this.$shownBefore(v, node, pass)) {
          want = v;
          break;
        }
      }
    }
    pass.shown.set(key, want);
    return want;
  }

  /** Whether a block before `node` in document order shows `id`. */
  private $shownBefore(
    id: string,
    node: LexicalNode,
    pass: SettlePass,
  ): boolean {
    const claimants = this.$claimants(id, pass);
    let at: number[] | null = null;
    for (const other of claimants) {
      if (other.getKey() === node.getKey()) {
        continue;
      }
      if (at === null) {
        at = $pathOf(node, pass);
      }
      if (comparePaths($pathOf(other, pass), at) >= 0) {
        break;
      }
      if (this.$shownId(other, pass) === id) {
        return true;
      }
    }
    return false;
  }

  /** The id a block derives from its Yjs identity (see derivedBlockId). */
  private $derivedIdOf(node: LexicalNode): string | null {
    const state = this.state;
    const unit = state.unitByKey.get(node.getKey());
    if (unit !== undefined && unit.key === node.getKey()) {
      return unit.end !== null
        ? derivedBlockId(unit.end)
        : unit.kind === 'implicit'
          ? implicitIdOf(unit)
          : null;
    }
    // A stored node, a list stored as a node included: from its own item,
    // which no edit of its content changes.
    const y = state.yByKey.get(node.getKey());
    if (y !== undefined) {
      return y._item === null ? null : storedDerivedId(node, y._item);
    }
    // A paragraph a read made around a run of inline content in a shadow
    // root: from the run's first item (see noteInlineRun).
    const first = state.inlineRunStart.get(node.getKey());
    if (first !== undefined) {
      return implicitBlockId(first, first.right);
    }
    if ($isGroupNode(node)) {
      // From its first line, and its level (a list nested at the start of
      // a list shares that line).
      const end = this.$firstLineEnd(node);
      return end === null
        ? null
        : derivedBlockId(end) + groupSuffix(this.$groupsAbove(node));
    }
    // A wrapper item: from its nested group's first item, and its level
    // (wrappers nested at the start of a list share that item).
    const g = $isElementNode(node) ? node.getFirstChild() : null;
    if ($isGroupNode(g)) {
      const end = this.$firstLineEnd(g);
      return end === null
        ? null
        : derivedBlockId(end) +
            wrapperSuffix(Math.max(0, this.$groupsAbove(node) - 1));
    }
    return null;
  }

  /**
   * The paragraph around a run of inline content in a shadow root that
   * derives `base` from the run's first item, `item` (see noteInlineRun):
   * among the paragraphs of the line holding `item` (the first live end item
   * after it), or of the inline container `cs`.
   */
  private $inlineRunDeriving(
    item: Item,
    base: string,
    cs: CS,
  ): LexicalNode | null {
    const state = this.state;
    let holder: LexicalNode | null = null;
    if (cs.kind === 'i') {
      holder = $getNodeByKey(cs.key);
    } else {
      for (let it = item.right; it !== null; it = it.right) {
        if (isShownEnd(it, state.hidden)) {
          const u = state.unitByEnd.get(it);
          holder =
            u === undefined || u.key === null ? null : $getNodeByKey(u.key);
          break;
        }
      }
    }
    if (!$isElementNode(holder) || !holder.isShadowRoot()) {
      return null;
    }
    for (const c of holder.getChildren()) {
      if (
        state.inlineRunStart.has(c.getKey()) &&
        this.$derivedIdOf(c) === base
      ) {
        return c;
      }
    }
    return null;
  }

  /** The end item of the first line under a group (descending into it). */
  private $firstLineEnd(group: ElementNode): Item | null {
    for (let n: LexicalNode | null = group.getFirstChild(); n !== null; ) {
      const u = this.state.unitByKey.get(n.getKey());
      if (u !== undefined && u.end !== null) {
        return u.end;
      }
      n = $isElementNode(n) ? n.getFirstChild() : null;
    }
    return null;
  }

  /** How many groups hold `node`, inside its container. */
  private $groupsAbove(node: LexicalNode): number {
    let level = 0;
    for (let p = node.getParent(); p !== null; p = p.getParent()) {
      if ($isGroupNode(p)) {
        level++;
      }
      if ($isRootNode(p) || this.state.csByKey.has(p.getKey())) {
        break;
      }
    }
    return level;
  }

  /**
   * The block that derives `id` (see $derivedIdOf), if `id` has the form of
   * a derived id, possibly followed by `_d`s, and such a block is shown,
   * whether or not it stores an id: a block storing a copy of that id (a
   * block's JSON copied with the id a reader showed) competes with it.
   */
  private $derivingBlock(id: string): LexicalNode | null {
    const parsed = parseDerivedId(id);
    if (parsed === null) {
      return null;
    }
    const {base, client, clock} = parsed;
    const state = this.state;
    const store = state.doc.store;
    if (
      !Number.isSafeInteger(client) ||
      !Number.isSafeInteger(clock) ||
      store.getClock(client) <= clock
    ) {
      return null;
    }
    const item = store.getItem(createID(client, clock));
    if (!(item instanceof Item) || item.id.clock !== clock || item.deleted) {
      return null;
    }
    const unit = state.unitByEnd.get(item);
    const key =
      unit !== undefined && unit.key !== null
        ? unit.key
        : item.content instanceof ContentType
          ? state.keyByY.get(item.content.type)
          : undefined;
    if (key === undefined) {
      // A line without a marker derives its id from its first character.
      const cs = state.containers.get(item.parent as YNode);
      if (cs === undefined) {
        return null;
      }
      for (const u of cs.units) {
        if (u.kind === 'implicit' && u.key !== null) {
          const n = $getNodeByKey(u.key);
          if (n !== null && this.$derivedIdOf(n) === base) {
            return n;
          }
        }
      }
      return this.$inlineRunDeriving(item, base, cs);
    }
    // The line or node itself, or the group or wrapper item it is the first
    // line of.
    for (
      let n: LexicalNode | null = $getNodeByKey(key);
      n !== null && !$isRootNode(n);
      n = n.getParent()
    ) {
      if (this.$derivedIdOf(n) === base) {
        return n;
      }
      if (n !== null && state.csByKey.has(n.getKey()) && n.getKey() !== key) {
        break;
      }
    }
    return null;
  }
}

/**
 * Note the ids whose claimants an update changed beyond what its reads
 * noted as they went (see BlockIdIndex#noteStoredId and
 * BlockIdSettler#noteDerived): a block removed leaves the index, and the id
 * it stored and the id it showed are settled again (blocks that fell back
 * because of it may show it now); a block shown with another id than before
 * the update has both settled (a group whose first line changed, a line read
 * again with the id it stores); a changed block that holds an id another
 * block claims too has it settled (it may have moved past that block).
 * Proportional to what the update changed.
 */
function $touchChanged(
  state: State,
  dirtyElements: ReadonlyMap<NodeKey, unknown> = state.editor._dirtyElements,
  dirtyLeaves: ReadonlySet<NodeKey> = state.editor._dirtyLeaves,
  before: ReadonlyMap<NodeKey, LexicalNode> = state.editor._editorState
    ._nodeMap,
  touch: (id: string) => void = id => state.ids.touchedIds.add(id),
): void {
  const seen = new Set<NodeKey>();
  const removed = (key: NodeKey, prev: LexicalNode | undefined) => {
    const stored = state.ids.storedIdOf.get(key);
    state.ids.noteStoredId(key, undefined);
    const was =
      prev === undefined
        ? undefined
        : $getState(prev, blockIdState, NODE_STATE_DIRECT);
    for (const id of [stored, was]) {
      if (typeof id === 'string') {
        touch(id);
      }
    }
    // What it held went with it (Lexical marks only the node removed).
    if ($isElementNode(prev)) {
      for (let c = prev.__first; c !== null; ) {
        const child = before.get(c);
        if (child === undefined) {
          break;
        }
        if (!seen.has(c)) {
          const now = $getNodeByKey(c);
          // One placed elsewhere is changed (see visit), not removed.
          if (now === null || !now.isAttached()) {
            seen.add(c);
            removed(c, child);
          }
        }
        c = child.__next;
      }
    }
  };
  const visit = (key: NodeKey) => {
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const node = $getNodeByKey(key);
    const prev = before.get(key);
    if ($isTextNode(node) || (node === null && $isTextNode(prev))) {
      return;
    }
    if (node === null || !node.isAttached()) {
      removed(key, prev);
      return;
    }
    const was =
      prev === undefined
        ? undefined
        : $getState(prev, blockIdState, NODE_STATE_DIRECT);
    const now = $getState(node, blockIdState);
    if (prev !== undefined && was !== now) {
      for (const id of [was, now]) {
        if (typeof id === 'string') {
          touch(id);
        }
      }
    }
    // Moved (or new), with what it holds: it may have moved past another
    // holder of an id it claims. Typing in a block does not move it.
    if (
      prev === undefined ||
      prev.__parent !== node.__parent ||
      prev.__prev !== node.__prev ||
      prev.__next !== node.__next
    ) {
      const holds = (n: LexicalNode) => {
        for (const id of [
          $getState(n, blockIdState),
          state.ids.storedIdOf.get(n.getKey()),
        ]) {
          if (typeof id === 'string' && state.ids.repeatedIds.has(id)) {
            touch(id);
          }
        }
        if ($isElementNode(n)) {
          for (const c of n.getChildren()) {
            holds(c);
          }
        }
      };
      holds(node);
    }
  };
  for (const key of dirtyElements.keys()) {
    visit(key);
  }
  for (const key of dirtyLeaves) {
    visit(key);
  }
}

/**
 * The block id stored for a node a read gave one (see BlockIdIndex), as
 * the document holds it now: a line's marker, a stored node's attributes, a
 * top-level group's first item's marker.
 */
function $storedIdNow(state: State, node: LexicalNode): unknown {
  const key = node.getKey();
  const k = STATE_PREFIX + blockIdState.key;
  const unit = state.unitByKey.get(key);
  if (unit !== undefined && unit.key === key) {
    return unit.end === null
      ? undefined
      : shownAttrs(unit.end, state.hidden)[k];
  }
  const isGroup = $isElementNode(node) && getGroupSpec(klassOf(node)) !== null;
  const y = state.yByKey.get(key);
  if (y !== undefined) {
    // A stored node (a list stored as a node too): its attributes.
    return y.getAttr(k);
  }
  if (!$isElementNode(node)) {
    return state.ids.storedIdOf.get(key);
  }
  // A group's id is stored with its level's key by its first item, a
  // wrapper item's in its nested items' outer keys (see Reader#$groupChildren):
  // read from the first line under it.
  const first = node.getFirstChild();
  if (
    !isGroup &&
    !($isElementNode(first) && getGroupSpec(klassOf(first)) !== null)
  ) {
    return state.ids.storedIdOf.get(key);
  }
  let groups = 0;
  let line: Unit | undefined;
  for (let n: LexicalNode | null = first; n !== null; ) {
    const u = state.unitByKey.get(n.getKey());
    if (u !== undefined && u.key === n.getKey()) {
      line = u;
      break;
    }
    if (!$isElementNode(n)) {
      break;
    }
    if (getGroupSpec(klassOf(n)) !== null) {
      groups++;
    }
    n = n.getFirstChild();
  }
  if (line === undefined || line.end === null) {
    return state.ids.storedIdOf.get(key);
  }
  const attrs = shownAttrs(line.end, state.hidden);
  // Only a marker that puts its line in a group records group ids (see
  // Reader#$groupOf): an item whose group key concurrent edits removed is
  // read in a group of its own class's, which stores none.
  const nodes = state.editor._nodes;
  const g = attrs[GROUP_KEY];
  const ginfo = typeof g === 'string' ? nodes.get(g) : undefined;
  const spec = ginfo === undefined ? null : getGroupSpec(ginfo.klass);
  const t = attrs[TYPE_KEY];
  const info = nodes.get(typeof t === 'string' ? t : 'paragraph');
  if (spec === null || info === undefined || !spec.items.includes(info.klass)) {
    return undefined;
  }
  const lv = attrs[LEVEL_KEY];
  const level = typeof lv === 'number' && Number.isInteger(lv) ? lv : 0;
  const idIn = (st: unknown): unknown =>
    st !== null && typeof st === 'object' && !Array.isArray(st)
      ? (st as Attrs)[blockIdState.key]
      : undefined;
  if (isGroup && groups === 0) {
    return idIn(attrs[GROUP_FIELD_PREFIX + '$']);
  }
  const at = level - groups;
  const outer = attrs[OUTER_KEY];
  const entry =
    Array.isArray(outer) && outer.length === level && at >= 0
      ? outer[at]
      : undefined;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return state.ids.storedIdOf.get(key);
  }
  if (isGroup) {
    return idIn((entry as Attrs).$);
  }
  const w = (entry as Attrs)[WRAPPER_FIELDS_KEY];
  return w !== null && typeof w === 'object' && !Array.isArray(w)
    ? idIn((w as Attrs).$)
    : undefined;
}

/**
 * One settling of block ids (see BlockIdSettler#$settleIds): what it
 * computed.
 */
type SettlePass = {
  readonly shown: Map<NodeKey, string | null>;
  readonly claimants: Map<string, LexicalNode[]>;
  readonly paths: Map<NodeKey, number[]>;
  /** Index within its parent, for every child of a parent walked once. */
  readonly index: Map<NodeKey, number>;
};

function newSettlePass(): SettlePass {
  return {
    claimants: new Map(),
    index: new Map(),
    paths: new Map(),
    shown: new Map(),
  };
}

/**
 * A node's position in the document (see comparePaths). Each parent's
 * children are counted once per pass, so placing many blocks of one parent
 * costs one walk of it, not one per block.
 */
function $pathOf(n: LexicalNode, pass: SettlePass): number[] {
  let path = pass.paths.get(n.getKey());
  if (path === undefined) {
    path = [];
    for (let x: LexicalNode | null = n; x !== null && !$isRootNode(x); ) {
      const parent: ElementNode | null = x.getParent();
      let i = pass.index.get(x.getKey());
      if (i === undefined && parent !== null) {
        let k = 0;
        for (
          let c: LexicalNode | null = parent.getFirstChild();
          c !== null;
          c = c.getNextSibling()
        ) {
          pass.index.set(c.getKey(), k++);
        }
        i = pass.index.get(x.getKey());
      }
      path.push(i === undefined ? x.getIndexWithinParent() : i);
      x = parent;
    }
    path.reverse();
    pass.paths.set(n.getKey(), path);
  }
  return path;
}

/** Document order of two positions (see $pathOf). */
function comparePaths(pa: number[], pb: number[]): number {
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] !== pb[i]) {
      return pa[i] - pb[i];
    }
  }
  return pa.length - pb.length;
}

// ---------------------------------------------------------------------------
// After a local write

/**
 * The ids whose holders a local write changed (see YBinding#onUpdate): an id
 * it stored or stopped storing on a block it wrote, the ids a block it
 * removed stored and showed, the ids a block now shows instead of another,
 * and a repeated id held by a block it changed (which may have moved past
 * another holder). Only those can show differently now, so only those are
 * checked (not every repeated id: the editor already shows the others as a
 * read settled them). Returns, of those, the ids the editor does not show as
 * a read settles them (an id another block stores too, or that a removed
 * block held first: a reader gives the later holder its derived id, or the
 * remaining one the stored id), with the blocks that store or derive them
 * (see BlockIdSettler#$claimants); null when the write changed no holder.
 */
export function $unsettledAfterWrite(
  state: State,
  dirtyElements: Map<NodeKey, boolean>,
  dirtyLeaves: Set<NodeKey>,
  before: ReadonlyMap<NodeKey, LexicalNode>,
): {ids: Set<string>; claimants: LexicalNode[]} | null {
  const changed = new Set<string>();
  for (const key of dirtyElements.keys()) {
    const node = $getNodeByKey(key);
    if (node !== null && node.isAttached()) {
      const was = state.ids.storedIdOf.get(key);
      const now = $storedIdNow(state, node);
      if (was !== now) {
        state.ids.noteStoredId(key, now);
        if (was !== undefined) {
          changed.add(was);
        }
        if (typeof now === 'string') {
          changed.add(now);
        }
      }
    }
  }
  $touchChanged(state, dirtyElements, dirtyLeaves, before, id =>
    changed.add(id),
  );
  if (changed.size === 0) {
    return null;
  }
  const touched = new Set(state.ids.touchedIds);
  const settler = new BlockIdSettler(state);
  const unsettled = new Set(settler.$unsettled(changed));
  // Holders the check found removed (see BlockIdSettler#$storers).
  for (const id of state.ids.touchedIds) {
    if (!touched.has(id)) {
      unsettled.add(id);
    }
  }
  return {claimants: settler.$claimantsOf(unsettled), ids: unsettled};
}

// ---------------------------------------------------------------------------
// The self-check

/**
 * Where the editor and a read of one container give a block different ids,
 * one of which the document stores on several blocks (any, with `'all'`),
 * take the editor's.
 */
export function forgiveRepeatedIds(
  live: Attrs,
  read: Attrs,
  repeated: ReadonlySet<string> | 'all',
): void {
  const idOf = (json: Attrs): unknown => {
    const st = json.$;
    return st !== null && typeof st === 'object' && !Array.isArray(st)
      ? (st as Attrs)[blockIdState.key]
      : undefined;
  };
  const id = idOf(read);
  const mine = idOf(live);
  if (
    id !== mine &&
    (repeated === 'all' ||
      (typeof id === 'string' && repeated.has(id)) ||
      (typeof mine === 'string' && repeated.has(mine)))
  ) {
    read.$ = {...(read.$ as Attrs), [blockIdState.key]: mine};
  }
  const a = live.children;
  const b = read.children;
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      const y = b[i];
      if (
        x !== null &&
        typeof x === 'object' &&
        y !== null &&
        typeof y === 'object'
      ) {
        forgiveRepeatedIds(x as Attrs, y as Attrs, repeated);
      }
    }
  }
  const sa = live.$slots;
  const sb = read.$slots;
  if (
    sa !== null &&
    typeof sa === 'object' &&
    sb !== null &&
    typeof sb === 'object'
  ) {
    for (const name in sa as Attrs) {
      const x = (sa as Attrs)[name];
      const y = (sb as Attrs)[name];
      if (
        x !== null &&
        typeof x === 'object' &&
        y !== null &&
        typeof y === 'object'
      ) {
        forgiveRepeatedIds(x as Attrs, y as Attrs, repeated);
      }
    }
  }
}
