/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Hidden} from './Hidden';
import type {View} from './Unread';

import invariant from '@lexical/internal/invariant';
import {
  ContentFormat,
  ContentString,
  ContentType,
  createID,
  type Doc,
  getItemCleanStart,
  Item,
  type Node as YNode,
  type Transaction,
} from '@y/y';

import {
  covered,
  endTarget,
  endValue,
  ensureIdentityRecord,
  type FoldIn,
  isEndValue,
  isIdentityValue,
  isOnStack,
  isPaired,
  isShadowKey,
  isValidEnd,
  keySlice,
  liveEndsOf,
  markPending,
  noteEnd,
  noteHolder,
  NULL_RUN,
  rootOf,
  seedRunsOf,
  stepPaired,
  unmarkPending,
  writesPairedRuns,
} from './Ident';
import {runBoundary, type StoredUnit, storedUnit} from './Layout3';
import {owned} from './Owned';
import {
  decodeFormatValue,
  formatFamily,
  MARKER,
  SEGMENT_KEY,
  STATE_PREFIX,
  TEXT_FORMAT_PREFIX,
  TYPE_KEY,
  WRAPPER_PREFIX,
} from './Schema';
import {deletedBy, deleteItemIn, isGoneIn} from './Seen';

/*
 * Anchored editing of a Y.Node's children.
 *
 * Y.Node#insert/delete/format take an index and walk the children from the
 * start of the type on every call (the delta position starts at `_start`), so
 * in a container that holds a whole document every keystroke would cost time
 * proportional to its position. This cursor starts from an item the binding
 * already knows (the marker of the previous line) and performs the same
 * operations as Yjs' own text positions (`ItemTextListPosition`,
 * `insertContent`, `deleteText`, `formatText` in Yjs' ynode.js, MIT
 * licensed), which are not exported. Only the parts this binding needs are
 * implemented: no renderer (attribution) support. A sequence of edits shows
 * the same content and formats as through Yjs (Cursor.test checks it against
 * Y.Node#applyDelta), but the items differ: a delete keeps every format item
 * in the run of deleted content and format items it leaves, which Yjs removes
 * as redundant and concurrent writers rely on (see delete), and a format
 * change keeps the items that bound the content around its range, opens its
 * value next to its content and closes it where the change that gave the
 * range its old value ends (see format), all per family of keys (see
 * formatFamily); an undo keeps some of the closers a
 * format change wrote (see YBinding#isKeptByUndo).
 */

export type Formats = Map<string, unknown>;

export const equalFormatValue = (a: unknown, b: unknown): boolean => {
  if (a === b) {
    return true;
  }
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  ) {
    return false;
  }
  // Yjs compares format values one level deep (object.equalFlat).
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) {
    return false;
  }
  for (const k of ak) {
    if (
      (a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]
    ) {
      return false;
    }
  }
  return true;
};

const __DEV__ = process.env.NODE_ENV !== 'production';

const isFormat = (item: Item): boolean => item.content instanceof ContentFormat;

const keyOf = (item: Item): string => (item.content as ContentFormat).key;
const valueOf = (item: Item): unknown => (item.content as ContentFormat).value;

/**
 * Whether live format item `item`, right after `prev`, the last item of
 * `unit`, belongs to that unit (see unitFrom).
 */
function continuesUnit(unit: Item[], prev: Item, item: Item): boolean {
  const key = keyOf(item);
  return (
    prev.id.client === item.id.client &&
    prev.id.clock + prev.length === item.id.clock &&
    formatFamily(keyOf(prev)) === formatFamily(key) &&
    !unit.some(u => keyOf(u) === key)
  );
}

/**
 * The items one write made together at one place for one family (see
 * formatFamily), from live format item `item` on: the following items, one
 * after the other with no other item between, of other keys of its family,
 * that its client made right after it. As a whole value's one item would,
 * they change the family's value there together. An item of a key that is
 * a family of its own is a unit of its own.
 */
function unitFrom(view: View | null, item: Item): Item[] {
  const unit = [item];
  for (
    let prev = item, it = item.right;
    it !== null &&
    !isGoneIn(view, it) &&
    isFormat(it) &&
    continuesUnit(unit, prev, it);
    prev = it, it = it.right
  ) {
    unit.push(it);
  }
  return unit;
}

/**
 * The null items a format change wrote after its range to end its value
 * there (see Cursor#format): an undo of the change keeps one where without
 * it the content after it would take a value, or where a collaborator
 * removed the change's own opener (see YBinding#isKeptByUndo).
 */
const formatClosers = new WeakSet<Item>();

/** Whether `item` is one of the items in `formatClosers`. */
export const isFormatCloser = (item: Item): boolean => formatClosers.has(item);

/**
 * Add `item` to `formatClosers`: the copy an undo or redo makes of an item
 * in it, which ends the same value at the same place.
 */
export const markFormatCloser = (item: Item): void => {
  formatClosers.add(item);
};

/**
 * Refuse to link a new item next to `left` and `right` unless both are in
 * `parent`, the type it is written to. An item whose neighbour sits in
 * another type is malformed: its own document links it into that type's list
 * while naming `parent` (every other client takes its parent from its origin,
 * so only this document holds it wrong), and later reads of that document go
 * wrong. A write that hits this throws, and is recovered
 * from (RECOVERED_WRITE_WARNING) instead of storing the item.
 */
function checkLinkable(
  left: Item | null,
  right: Item | null,
  parent: Item['parent'],
): void {
  if (
    (left !== null && left.parent !== parent) ||
    (right !== null && right.parent !== parent)
  ) {
    throw new Error(
      'refused to write an item next to an item of another shared type',
    );
  }
}

/**
 * The item that ends the run `item`, a format item, opened in the write that
 * made it: the first item of its key, with another value, in the same shared
 * type, that its client made after it (one write's items are one after the
 * other in its client's clock order; looked for among the next 64). A run
 * cannot end in another type: a write's items in other containers are
 * passed over. Null when none is found.
 */
export function changeEnd(doc: Doc, item: Item): Item | null {
  const {key, value} = item.content as ContentFormat;
  const {client} = item.id;
  const end = doc.store.getClock(client);
  let clock = item.id.clock + item.length;
  for (let steps = 0; clock < end && steps < 64; steps++) {
    const next = doc.store.getItem(createID(client, clock));
    if (!(next instanceof Item)) {
      return null;
    }
    if (
      next.parent === item.parent &&
      next.content instanceof ContentFormat &&
      next.content.key === key &&
      !equalFormatValue(next.content.value, value)
    ) {
      return next;
    }
    clock = next.id.clock + next.length;
  }
  return null;
}

/**
 * The item its client made last before `item` (looked for among the 64
 * structs before it, in clock order) of the key `key` in the same shared
 * type, or null.
 */
function lastOwnItemBefore(doc: Doc, item: Item, key: string): Item | null {
  const {client} = item.id;
  let clock = item.id.clock - 1;
  for (let steps = 0; clock >= 0 && steps < 64; steps++) {
    const prev = doc.store.getItem(createID(client, clock));
    if (!(prev instanceof Item)) {
      return null;
    }
    if (
      prev.parent === item.parent &&
      prev.content instanceof ContentFormat &&
      prev.content.key === key
    ) {
      return prev;
    }
    clock = prev.id.clock - 1;
  }
  return null;
}

/**
 * Whether null `item` is the end its client gave a run it opened in the
 * same write (see changeEnd): the item of its key its client made last
 * before it opens a run that ends at `item`.
 */
function isChangeEnd(doc: Doc, item: Item): boolean {
  const opener = lastOwnItemBefore(doc, item, keyOf(item));
  return (
    opener !== null &&
    valueOf(opener) !== null &&
    changeEnd(doc, opener) === item
  );
}

/** The nearest live item of `key` before `item`, among the 4096 before it. */
function liveItemBefore(item: Item, key: string): Item | null {
  let steps = 0;
  for (let it = item.left; it !== null && steps < 4096; it = it.left, steps++) {
    if (!it.deleted && isFormat(it) && keyOf(it) === key) {
      return it;
    }
  }
  return null;
}

/**
 * The item that opened the run live format item `item` gives its value in:
 * `item` itself, or, where it is a restore (its client wrote it after text
 * it inserted inside the run, with a null of the key before that text), the
 * opener of the run that restore restates, and so on.
 */
export function runOpener(doc: Doc, item: Item): Item {
  const {key, value} = item.content as ContentFormat;
  let current = item;
  for (let depth = 0; depth < 16; depth++) {
    const negation = lastOwnItemBefore(doc, current, key);
    if (negation === null || valueOf(negation) !== null) {
      return current;
    }
    let found = false;
    let steps = 0;
    for (
      let it = current.left;
      it !== null && steps < 512;
      it = it.left, steps++
    ) {
      if (it === negation) {
        found = true;
        break;
      }
      if (!it.deleted && isFormat(it) && keyOf(it) === key) {
        break;
      }
      // A restore follows text its own client inserted inside the run,
      // after the null (see insertNegatedFormats): content of another
      // client between them means `current` opens a run of its own (its
      // client's earlier end and later opener, #9599).
      if (!isFormat(it) && it.id.client !== current.id.client) {
        break;
      }
    }
    const source = found ? liveItemBefore(negation, key) : null;
    if (source === null || !equalFormatValue(valueOf(source), value)) {
      return current;
    }
    current = source;
  }
  return current;
}

/** A live countable item: text, a child node, an embed. */
export const isLiveContent = (view: View | null, item: Item): boolean =>
  !isGoneIn(view, item) && item.countable;

/**
 * Names a stored element the editor does not show (see $isLeftOutInline),
 * or null where none is left out.
 */
export type LeftOut = ((item: Item) => boolean) | null;

/**
 * Whether `item` is content the editor shows: live content (see
 * isLiveContent) that `leftOut` does not name. The one rule the writer counts
 * positions by: the cursor's moves and deletes, a removed line's delete (see
 * countLive), the stored atoms a format pass compares (readAtomsLimited), and
 * whether an element holds content (hasLiveContent).
 */
export const isShownContent = (
  view: View | null,
  item: Item,
  leftOut: LeftOut,
): boolean => isLiveContent(view, item) && !(leftOut !== null && leftOut(item));

/** An opener of a node type key (`t`) or segment key (`k`). */
function isNodeTypeOpener(content: ContentFormat): boolean {
  // An end or a `[]` opener of a paired run closes a type, as null does.
  return (
    (content.key === TYPE_KEY || content.key === SEGMENT_KEY) &&
    content.value !== null &&
    !isIdentityValue(content.value)
  );
}

/** Whether end `end` names an opener client `client` wrote. */
function isOwnEnd(end: Item, client: number): boolean {
  const target = endTarget(end);
  return target !== null && target.client === client;
}

/**
 * Whether a paired run of `key` that a format change writes ends after the
 * format items following its last content (text formats, set members such as
 * comment ids), rather than right after the content (a node's own keys and
 * wrappers: see Cursor#formatCovered).
 */
function extendsPastContent(key: string): boolean {
  return key.startsWith(TEXT_FORMAT_PREFIX) || key.startsWith(STATE_PREFIX);
}

/**
 * Whether live format item `item` is part of a node's opener: a node type or
 * segment key opener, or an item of the write that wrote one right after it
 * (one client, consecutive format items).
 */
function opensNodeRun(item: Item): boolean {
  let prev: Item | null = null;
  for (
    let it: Item | null = item;
    it !== null && isFormat(it);
    prev = it, it = it.right
  ) {
    if (
      prev !== null &&
      (it.id.client !== prev.id.client ||
        it.id.clock !== prev.id.clock + prev.length)
    ) {
      return false;
    }
    if (!it.deleted && isNodeTypeOpener(it.content as ContentFormat)) {
      return true;
    }
  }
  return false;
}

export class Cursor {
  left: Item | null;
  right: Item | null;
  formats: Formats;
  /**
   * Remote changes the editor holds back (see Hidden): the cursor works on
   * what the editor shows, so held content is not counted or deleted, and a
   * held format gives nothing a value, is never deleted, and is stepped over
   * wherever the cursor looks for format items.
   */
  hidden: Hidden | null = null;
  /**
   * Live items the editor does not show (see $isLeftOutInline): not counted,
   * as held content is not; deleted only where a delete meets one before its
   * last unit (see delete), or past the end of content a write ends (see
   * deleteLeftOutBefore).
   */
  leftOut: LeftOut = null;
  /**
   * The live format item that gave each key its value at the cursor, for
   * the keys whose format items the cursor passed.
   */
  private readonly sources = new Map<string, Item>();
  /** The openers of paired runs the running insert wrote, by key. */
  private readonly openers = new Map<string, Item>();
  /** Whether this document gets paired runs (see writesPairedRuns). */
  private paired: boolean | null = null;

  /** The shared root of the cursor's container. */
  private root: YNode | null = null;
  /** Whether this client's layout 3 record is known to be written. */
  private recorded = false;

  /** Whether this write stores `key` as paired runs (see covered). */
  private pairs(key: string): boolean {
    return this.writesPaired() && covered(key);
  }

  /** Whether this cursor writes paired runs (see writesPairedRuns). */
  private writesPaired(): boolean {
    if (this.paired === null) {
      // Its binding's root (nested or not, see Ident.rootOf).
      const root = rootOf(this.parent);
      this.root = root;
      this.paired = writesPairedRuns(this.tr.doc, root);
    }
    return this.paired;
  }

  /** The fold of this cursor's steps (see stepperFor). */
  private step: ((formats: Formats, it: Item, f: FoldIn) => void) | null = null;
  /**
   * Whether opener `it` is paired as the editor shows it: an end the hold
   * holds back pairs nothing (see Reader#held).
   */
  private pairedShown(it: Item): boolean {
    return isPaired(it, this.shownFold());
  }

  /** The fold of what the editor shows: this view, this hold (see FoldIn). */
  private shown: FoldIn | null = null;
  private shownFold(): FoldIn {
    if (
      this.shown === null ||
      this.shown.held !== this.hidden ||
      this.shown.view !== this.view
    ) {
      this.shown = {held: this.hidden, view: this.view};
    }
    return this.shown;
  }

  /** The fold of what is stored: this view, no hold (see FoldIn). */
  private storedFold: FoldIn | null = null;
  private stored(): FoldIn {
    if (this.storedFold === null || this.storedFold.view !== this.view) {
      this.storedFold = {held: null, view: this.view};
    }
    return this.storedFold;
  }

  /**
   * Step format item `it` into `formats` as the editor shows it: an end the
   * hold holds back pairs nothing (see Reader#held). The cursor walks
   * what the editor shows (held formats are passed over, see isHeldFormat).
   */
  private stepShown(formats: Formats, it: Item): void {
    const step = (this.step ??= stepPaired);
    step(formats, it, this.shownFold());
  }

  /** Before this write's first paired item (see ensureIdentityRecord). */
  private beforePairedItem(): void {
    if (!this.recorded) {
      this.recorded = true;
      ensureIdentityRecord(this.root!);
      // The document may read as paired runs from here on.
      this.step = null;
    }
  }

  /** Write, at the cursor, the end of the paired run `opener` opened. */
  private writeEnd(key: string, opener: Item): Item {
    const doc = this.tr.doc;
    const id = createID(doc.clientID, doc.store.getClock(doc.clientID));
    const end = this.newItem(
      new ContentFormat(key, endValue(id, opener.id) as unknown as object),
    );
    noteEnd(doc, end, 'written');
    noteHolder(end);
    unmarkPending(opener);
    this.right = end;
    this.forward();
    return end;
  }
  /**
   * While a format change walks its range (see format, rule 3): the key
   * and client of each format item the cursor passed that this transaction
   * did not make, and the value of those deleted before it.
   */
  private passed: Set<string> | null = null;
  /**
   * Where `formats` was folded up to, when past `left` (see Seen.frontierOf):
   * until the cursor passes it, the format items it steps over are in
   * `formats` already, so a paired run is not stepped twice; plain values,
   * which set themselves again, still step (main's order of sources).
   */
  private frontier: Item | null;
  constructor(
    readonly tr: Transaction,
    readonly parent: YNode,
    left: Item | null,
    formats: Formats,
    frontier: Item | null = null,
    /** What the write sees of the document (see View). */
    readonly view: View | null = null,
  ) {
    this.frontier = frontier;
    this.left = left;
    this.right = left === null ? parent._start : left.right;
    this.formats = formats;
    // Index search markers would not follow these item-level edits.
    if (parent._searchMarker !== null) {
      parent._searchMarker.length = 0;
    }
  }

  /** Whether `item` is a format the editor holds back (see hidden). */
  private isHeldFormat(item: Item): boolean {
    return this.hidden !== null && isFormat(item) && this.hidden.hides(item);
  }

  /**
   * The unit of format items from live format item `item` on (see
   * unitFrom). Where this write stores its key as paired runs: by position, never by which
   * write made them: the items right after it, one after the other, of its
   * family, up to the first item of another family, a held or gone item,
   * content, or a second item of a key the unit already has (whoever wrote
   * them, whatever their clocks: a closer and the next run's opener of one
   * key are two units, as one write's items of one key never are one). Elsewhere (below layout 3, and
   * uncovered keys), main's unit.
   */
  private unitAt(item: Item): Item[] {
    if (!this.pairs(keyOf(item))) {
      return unitFrom(this.view, item);
    }
    const family = formatFamily(keyOf(item));
    const unit = [item];
    const keys = new Set([keyOf(item)]);
    for (
      let it = item.right;
      it !== null &&
      !isGoneIn(this.view, it) &&
      isFormat(it) &&
      !this.isHeldFormat(it) &&
      formatFamily(keyOf(it)) === family &&
      !keys.has(keyOf(it));
      it = it.right
    ) {
      unit.push(it);
      keys.add(keyOf(it));
    }
    return unit;
  }

  /**
   * Whether live format item `item` is part of a node's opener (see
   * opensNodeRun). Where this write stores its key as paired runs: by position and stored
   * pairing, never by which write made the items: the openers from `item`
   * on, before the next content (gone items aside; a held item, an end or a
   * plain null ends the search), reach a live node type or segment opener,
   * paired or not (a pre-upgrade header).
   * Elsewhere, main's test.
   */
  private opensNode(item: Item): boolean {
    if (!this.pairs(keyOf(item))) {
      return opensNodeRun(item);
    }
    for (let it: Item | null = item; it !== null; it = it.right) {
      if (isGoneIn(this.view, it)) {
        continue;
      }
      if (!isFormat(it) || this.isHeldFormat(it)) {
        return false;
      }
      if (isNodeTypeOpener(it.content as ContentFormat)) {
        // (Whether or not its run holds content yet: an empty node run is
        // still the header the node's content goes after.)
        return true;
      }
      // An end or a plain null closes another run: the header of a node is
      // the openers right before its type opener (stepping past a closer
      // puts nothing between a node's opener and its content).
      const v = valueOf(it);
      if (v === null || isEndValue(v)) {
        return false;
      }
    }
    return false;
  }

  /** Step over `right`, tracking formats. */
  forward(): void {
    const item = this.right!;
    if (this.isHeldFormat(item)) {
      this.left = item;
      this.right = item.right;
      return;
    }
    if (
      !isLiveContent(this.view, item) &&
      this.passed !== null &&
      isFormat(item) &&
      !this.tr.insertSet.hasId(item.id)
    ) {
      const of = `${keyOf(item)}\u0000${item.id.client}`;
      this.passed.add(
        !isGoneIn(this.view, item) || this.tr.deleteSet.hasId(item.id)
          ? of
          : `${of}\u0000${JSON.stringify(valueOf(item))}`,
      );
    }
    if (item === this.frontier) {
      this.frontier = null;
    }
    if (!isGoneIn(this.view, item) && isFormat(item)) {
      this.sources.set(keyOf(item), item);
      if (this.frontier === null || !covered(keyOf(item))) {
        this.stepShown(this.formats, item);
      }
    }
    this.left = item;
    this.right = item.right;
  }

  /**
   * Whether `item` (live content) counts: split it so that it is all hidden
   * or all shown, and answer whether it is shown.
   */
  private counts(item: Item): boolean {
    if (!isShownContent(this.view, item, this.leftOut)) {
      return false;
    }
    const hidden = this.hidden;
    if (hidden === null) {
      return true;
    }
    const [len, isHidden] = hidden.runs(item)[0];
    if (len < item.length) {
      getItemCleanStart(this.tr, createID(item.id.client, item.id.clock + len));
    }
    return !isHidden;
  }

  /**
   * Split live `item` after its first `n` units, so the cursor can stop
   * there. A debug assertion (development builds) that the split is at a
   * code-point boundary: Yjs replaces both halves of a surrogate pair it
   * splits with U+FFFD under their ids, which every reader shows while the
   * author's editor keeps the character (see Writer#$writeHunks, where
   * every text write is widened to whole code points).
   */
  private split(item: Item, n: number): void {
    if (__DEV__ && item.content instanceof ContentString) {
      const {str} = item.content;
      const c = str.charCodeAt(n - 1);
      const d = str.charCodeAt(n);
      invariant(
        !(c >= 0xd800 && c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff),
        '@lexical/y: a write splits a surrogate pair',
      );
    }
    getItemCleanStart(this.tr, createID(item.id.client, item.id.clock + n));
  }

  /**
   * Advance by `n` content units, splitting an item if needed. Format items
   * just before the target position are not passed.
   */
  advance(n: number): void {
    while (n > 0 && this.right !== null) {
      const item = this.right;
      if (this.counts(item)) {
        if (n < item.length) {
          this.split(item, n);
        }
        n -= item.length;
      }
      this.forward();
    }
    invariant(n <= 0, '@lexical/y: cursor advanced past the end');
  }

  private newItem(content: ContentFormat | ContentString | ContentType): Item {
    const doc = this.tr.doc;
    const client = doc.clientID;
    const left = this.left;
    const right = this.right;
    checkLinkable(left, right, this.parent);
    const item = new Item(
      createID(client, doc.store.getClock(client)),
      left,
      left && left.lastId,
      right,
      right && right.id,
      this.parent,
      null,
      content,
    );
    owned(doc, () => item.integrate(this.tr, 0));
    return item;
  }

  /**
   * Step over the items before the cursor's content that already give it
   * `formats`. Invariant: the cursor steps over an item only where its
   * family (see formatFamily) has, after the items of its unit (see
   * unitFrom), the value `formats` gives every key of it. Why: an item that
   * only changes another member of a family (a comment ending where another
   * goes on) is where a whole value's item would be that does not match;
   * written past it, a restore of the family after the content landed where
   * a concurrent format change of that content puts its own item, and the
   * client ids decided which one held (a comment resolved while a peer typed
   * plain text came back on the next character).
   */
  private minimizeFormatChanges(formats: Record<string, unknown>): void {
    while (this.right !== null) {
      const r = this.right;
      if (isGoneIn(this.view, r) || this.isHeldFormat(r)) {
        // a deleted item has no length, and a held format is not there:
        // step over it
      } else if (
        isFormat(r) &&
        this.pairs(keyOf(r)) &&
        isEndValue(valueOf(r)) &&
        isOwnEnd(r, this.tr.doc.clientID) &&
        equalFormatValue(
          this.formats.get(keyOf(r)) ?? null,
          formats[keyOf(r)] ?? null,
        )
      ) {
        // Paired runs: text typed at the end of this client's own run,
        // which already gives it its value, stays inside that run (as main's
        // stops before its own restore) instead of relying on what a
        // collaborator's run shows past it.
        // Unless pre-upgrade closers right past the own end give the typed
        // value (main's placement there: past the closers, no items).
        {
          const steps = this.stepsToGivingPosition(formats, true);
          if (steps > 0) {
            for (let i = 0; i < steps; i++) {
              this.forward();
            }
            continue;
          }
        }
        break;
      } else if (
        isFormat(r) &&
        this.unitGives(r, formats) &&
        (keyOf(r).startsWith(WRAPPER_PREFIX) || !this.opensNode(r))
      ) {
        // a format that already matches (never an item of another node's
        // opener, its type and segment keys and the formats its write
        // opened with them: content written past it would be inside that
        // node's run, between its opener and its content, and depend on
        // items that node's author owns; its wrapper items, a link around
        // the node, are stepped over as any other: the content shares the
        // link and goes with it)
      } else {
        const steps = this.stepsToGivingPosition(formats);
        if (steps > 0) {
          for (let i = 0; i < steps; i++) {
            this.forward();
          }
          continue;
        }
        break;
      }
      this.forward();
    }
  }

  /**
   * Paired runs: the number of items to step over, through the ends and
   * plain nulls that follow the cursor before the next content, to the
   * first position where every key shows what `formats` gives it, or 0 when
   * there is none.
   * One item at a time may not give it while several do: a run's end
   * followed by the pre-upgrade closers of the word around it (the end
   * shows the word's value again, the closers clear it). Inserting there
   * writes no format item and keeps the content out of the run, so that
   * run's author's undo leaves the content as it was typed (as main, which
   * writes no end there). Never past another node's opener, nor past this
   * client's own end where it already gives the key's value (see
   * minimizeFormatChanges). (A seed, the one write that stores no paired
   * runs, appends to an empty container: it never places among items.)
   */
  private stepsToGivingPosition(
    formats: Record<string, unknown>,
    allowOwn = false,
  ): number {
    const sim = new Map(this.formats);
    let n = 0;
    // Only a position past a pre-upgrade closer (a plain null, which the
    // change's last end stops before): past paired ends alone the cursor
    // keeps main's placement (its own items inside the runs).
    let unpaired = false;
    for (let x = this.right; x !== null; x = x.right) {
      n++;
      if (isGoneIn(this.view, x) || this.isHeldFormat(x)) {
        continue;
      }
      if (!isFormat(x)) {
        return 0;
      }
      const key = keyOf(x);
      const v = valueOf(x);
      if (
        // only items that take values away: ends and plain nulls (stepping
        // past an opener would put the text in another write's run)
        !(isEndValue(v) || v === null) ||
        (!key.startsWith(WRAPPER_PREFIX) && this.opensNode(x)) ||
        (!allowOwn &&
          this.pairs(key) &&
          isEndValue(valueOf(x)) &&
          isOwnEnd(x, this.tr.doc.clientID) &&
          equalFormatValue(sim.get(key) ?? null, formats[key] ?? null))
      ) {
        return 0;
      }
      this.stepShown(sim, x);
      if (v === null) {
        unpaired = true;
      }
      if (unpaired && this.gives(sim, formats)) {
        return n;
      }
      // or every key that already shows its value at the cursor shows it
      // there too (keys that do not are written by the insert either way)
      if (unpaired && this.givesMatching(sim, formats)) {
        return n;
      }
    }
    return 0;
  }

  /** Whether `shown` gives what `formats` gives for every key whose value at the cursor already does. */
  private givesMatching(
    shown: Map<string, unknown>,
    formats: Record<string, unknown>,
  ): boolean {
    const keys = new Set<string>();
    for (const k of [
      ...shown.keys(),
      ...this.formats.keys(),
      ...Object.keys(formats),
    ]) {
      keys.add(isShadowKey(k) ? k.slice(1) : k);
    }
    for (const key of keys) {
      const want = formats[key] ?? null;
      if (!equalFormatValue(this.formats.get(key) ?? null, want)) {
        continue;
      }
      if (!equalFormatValue(shown.get(key) ?? null, want)) {
        return false;
      }
    }
    return true;
  }

  /** Whether `shown` gives every key exactly what `formats` gives it. */
  private gives(
    shown: Map<string, unknown>,
    formats: Record<string, unknown>,
  ): boolean {
    for (const [key, value] of shown) {
      if (!isShadowKey(key) && !equalFormatValue(value, formats[key] ?? null)) {
        return false;
      }
    }
    for (const key in formats) {
      if (!equalFormatValue(shown.get(key) ?? null, formats[key] ?? null)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Whether every key of the family of `item` has, after the items of its
   * unit from `item` on, the value `formats` gives it (null where it gives
   * none).
   */
  private unitGives(item: Item, formats: Record<string, unknown>): boolean {
    const after = new Map<string, unknown>();
    const unit = this.unitAt(item);
    if (this.writesPaired() && unit.some(it => covered(keyOf(it)))) {
      // Paired runs: the value a key has after the unit is what the
      // stack of its runs shows, not the items' raw values.
      const sim = new Map(this.formats);
      for (const it of unit) {
        this.stepShown(sim, it);
      }
      for (const it of unit) {
        after.set(keyOf(it), sim.get(keyOf(it)) ?? null);
      }
    } else {
      for (const it of unit) {
        after.set(keyOf(it), valueOf(it));
      }
    }
    for (const [key, value] of after) {
      if (!equalFormatValue(formats[key] ?? null, value)) {
        return false;
      }
    }
    const family = formatFamily(keyOf(item));
    for (const [key, value] of this.formats) {
      if (
        !after.has(key) &&
        formatFamily(key) === family &&
        !equalFormatValue(formats[key] ?? null, value)
      ) {
        return false;
      }
    }
    for (const key in formats) {
      if (
        !after.has(key) &&
        !this.formats.has(key) &&
        formatFamily(key) === family &&
        formats[key] !== null
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Paired runs: the node keys content with `formats` writes as a run of its
   * own even where the cursor already shows their values: its type `t` and
   * segment `k` wherever its segment differs from the one shown (a node
   * Lexical keeps apart from its neighbour: a tab, a token). Why: the type
   * it shows would otherwise come from a run another write owns, which that
   * write's undo removes (a tab written next to another client's tab read
   * as text after that client undid its tab). Its fields (`p:`, style and
   * color) inherit as any format. Null when there are none.
   */
  private ownNodeKeys(formats: Record<string, unknown>): Set<string> | null {
    const segment = formats[SEGMENT_KEY] ?? null;
    if (
      segment === null ||
      equalFormatValue(this.formats.get(SEGMENT_KEY) ?? null, segment)
    ) {
      return null;
    }
    return TYPE_KEY in formats
      ? new Set([TYPE_KEY, SEGMENT_KEY])
      : new Set([SEGMENT_KEY]);
  }

  private insertFormats(
    formats: Record<string, unknown>,
    own: Set<string> | null = null,
  ): Formats {
    const negated: Formats = new Map();
    for (const key in formats) {
      const val = formats[key];
      const current = this.formats.get(key) ?? null;
      if (!equalFormatValue(current, val) || (own !== null && own.has(key))) {
        negated.set(key, current);
        if (this.pairs(key)) {
          // Paired runs: a run of its own, ended after the content (see
          // insertNegatedFormats).
          this.beforePairedItem();
          const opener = this.newItem(
            new ContentFormat(key, (val === null ? NULL_RUN : val) as object),
          );
          this.openers.set(key, opener);
          markPending(opener);
          this.right = opener;
        } else {
          this.right = this.newItem(new ContentFormat(key, val as object));
        }
        this.forward();
      }
    }
    return negated;
  }

  /**
   * Restore `negated` after inserted content, reusing the items there that
   * already restore a key. Invariant: the restore of a family (see
   * formatFamily) is never written after the items of a unit of it there
   * (see unitFrom), where a concurrent format change of the content after
   * puts its own item: it is written before them (see
   * minimizeFormatChanges). A restore of a value whose run another client's
   * change opened gets an end of this client's own after that change's end
   * (see format, rule 5).
   */
  private insertNegatedFormats(negated: Formats, closers = false): void {
    // Paired runs: each run this insert opened ends with an end naming
    // its opener, never a reused item, written among the other closers in
    // main's order (the order of `negated`), so where later content stops
    // among the closers is what it is on main for every other key.
    // The keys whose run, which this write opens, ends at another client's
    // change end it reuses (see format, rule 5).
    const reusedEnds: string[] = [];
    while (this.right !== null) {
      const r = this.right;
      if (!isGoneIn(this.view, r) && !this.isHeldFormat(r)) {
        if (
          !isFormat(r) ||
          this.openers.has(keyOf(r)) ||
          !equalFormatValue(negated.get(keyOf(r)), valueOf(r))
        ) {
          break;
        }
        const unit = this.unitAt(r);
        if (
          unit.every(it =>
            equalFormatValue(negated.get(keyOf(it)), valueOf(it)),
          )
        ) {
          const family = formatFamily(keyOf(r));
          const reused = new Set(unit.map(keyOf));
          let rest = false;
          for (const key of negated.keys()) {
            rest = rest || (!reused.has(key) && formatFamily(key) === family);
          }
          if (rest) {
            break;
          }
        }
        // (Main's rule, which infers a write from its client's clocks: never
        // for a key this write stores as paired runs, whose runs end at
        // their own ends.)
        if (
          valueOf(r) === null &&
          !this.pairs(keyOf(r)) &&
          r.id.client !== this.tr.doc.clientID &&
          isChangeEnd(this.tr.doc, r)
        ) {
          reusedEnds.push(keyOf(r));
        }
        negated.delete(keyOf(r));
      }
      this.forward();
    }
    for (const key of reusedEnds) {
      this.right = this.newItem(
        new ContentFormat(key, null as unknown as object),
      );
      if (closers) {
        formatClosers.add(this.right);
      }
      this.forward();
    }
    const ends: Item[] = [];
    for (const [key, val] of negated) {
      const opener = this.openers.get(key);
      if (opener !== undefined) {
        this.writeEnd(key, opener);
        continue;
      }
      // (Main's restated-value rule infers the restated run's write from
      // clocks: only for keys this write does not store as paired runs.)
      const end =
        val === null || this.pairs(key) ? null : this.restatedEnd(key, val);
      if (end !== null) {
        ends.push(end);
      }
      this.right = this.newItem(new ContentFormat(key, val as object));
      if (closers && val === null) {
        formatClosers.add(this.right);
      }
      this.forward();
    }
    for (const end of ends) {
      this.insertAfter(
        end,
        new ContentFormat(keyOf(end), null as unknown as object),
      );
    }
    this.openers.clear();
  }

  /**
   * For a restore of `key` to `value` written at the cursor: where the run it
   * restates was opened by another client's change (see runOpener; the item
   * that gave the content the value before this write is the nearest item of
   * the key before the cursor that this write did not make), and the next
   * live item of the key after the cursor with another value is that change's
   * own end of the run (see changeEnd), that end, after which the restore's
   * run gets an end of this client's own (see format, rule 5). Null
   * otherwise.
   */
  private restatedEnd(key: string, value: unknown): Item | null {
    const doc = this.tr.doc;
    let source: Item | null = null;
    let steps = 0;
    for (
      let it = this.left;
      it !== null && steps < 4096;
      it = it.left, steps++
    ) {
      if (
        isFormat(it) &&
        keyOf(it) === key &&
        !this.tr.insertSet.hasId(it.id) &&
        (!isGoneIn(this.view, it) || deletedBy(it, this.tr))
      ) {
        source = it;
        break;
      }
    }
    if (source === null || !equalFormatValue(valueOf(source), value)) {
      return null;
    }
    const opener = runOpener(doc, source);
    if (opener.id.client === doc.clientID) {
      return null;
    }
    for (let it = this.right; it !== null; it = it.right) {
      if (
        isGoneIn(this.view, it) ||
        !isFormat(it) ||
        keyOf(it) !== key ||
        equalFormatValue(valueOf(it), value)
      ) {
        continue;
      }
      return valueOf(it) === null && changeEnd(doc, opener) === it ? it : null;
    }
    return null;
  }

  /** Write `content` right after `left`, away from the cursor. */
  private insertAfter(left: Item, content: ContentFormat): Item {
    const doc = this.tr.doc;
    const right = left.right;
    checkLinkable(left, right, this.parent);
    const item = new Item(
      createID(doc.clientID, doc.store.getClock(doc.clientID)),
      left,
      left.lastId,
      right,
      right && right.id,
      this.parent,
      null,
      content,
    );
    owned(doc, () => item.integrate(this.tr, 0));
    return item;
  }

  /**
   * Insert content with exactly `formats` (keys of current formats that
   * `formats` leaves out are removed for the inserted content). Returns the
   * content item.
   */
  insert(
    content: ContentString | ContentType,
    formats: Record<string, unknown>,
    fresh = false,
  ): Item {
    if (this.writesPaired()) {
      return this.insertWithFormats(content, formats, fresh);
    }
    // Seeding (see Ident.withSeeding): covered formats as canonical layout
    // 3 runs, written in this pass where the unit's values change (see
    // seedBoundary); the rest as main writes them.
    const seeded = new Map<string, unknown>();
    const rest: Record<string, unknown> = {};
    for (const key in formats) {
      if (!covered(key)) {
        rest[key] = formats[key];
      } else if (formats[key] !== null) {
        seeded.set(key, formats[key]);
      }
    }
    this.seedBoundary(storedUnit(seeded));
    // The covered keys the boundary left open hold exactly these values:
    // given as the cursor holds them, they write nothing more.
    this.formats.forEach((value, key) => {
      if (!isShadowKey(key) && covered(key)) {
        rest[key] = value;
      }
    });
    const item = this.insertWithFormats(content, rest);
    seedRunsOf(this.parent).last = item;
    return item;
  }

  /**
   * Seeding: before a unit with covered values `unit`, at the cursor, the
   * ends of the seed's runs that stop there and the openers of the runs
   * that start there (Layout3's runBoundary, the canonical form's rule).
   */
  private seedBoundary(unit: StoredUnit): void {
    const runs = seedRunsOf(this.parent);
    const {ends, starts} = runBoundary(runs.unit, unit);
    const client = this.tr.doc.clientID;
    for (const key of ends) {
      const opener = runs.openers.get(key)!;
      runs.openers.delete(key);
      const clock = this.tr.doc.store.getClock(client);
      this.seedFormatItem(key, [clock - opener.id.clock]);
    }
    for (const key of starts) {
      runs.openers.set(key, this.seedFormatItem(key, unit.get(key)![1]));
    }
    runs.unit = unit;
  }

  /** Write format item `key`=`value` at the cursor and step past it. */
  private seedFormatItem(key: string, value: unknown): Item {
    const item = this.newItem(new ContentFormat(key, value as object));
    this.right = item;
    this.forward();
    return item;
  }

  private insertWithFormats(
    content: ContentString | ContentType,
    formats: Record<string, unknown>,
    fresh = false,
  ): Item {
    const f: Record<string, unknown> = {...formats};
    // A tab's node type key (`t`, with its segment key `k`) applies to tab
    // characters only (see Reader's tabRuns): text inserted under an opener
    // another write left open neither closes nor reopens it, and a line
    // marker inserted under it closes it for good, so it ends with the line.
    const openTab =
      !(TYPE_KEY in formats) &&
      decodeFormatValue(this.formats.get(TYPE_KEY) ?? null) === 'tab';
    // (Not text with a segment key of its own, a node kept apart: a reader
    // reads text under a tab's type as plain text, without any segment key,
    // so its type is closed for it.)
    const plainText =
      openTab &&
      content instanceof ContentString &&
      !content.str.includes('\t') &&
      (formats[SEGMENT_KEY] ?? null) === null;
    const marker =
      openTab && content instanceof ContentType && content.type.name === MARKER;
    this.formats.forEach((_v, key) => {
      if (
        !isShadowKey(key) &&
        !(key in f) &&
        !(plainText && (key === TYPE_KEY || key === SEGMENT_KEY))
      ) {
        f[key] = null;
      }
    });
    this.minimizeFormatChanges(f);
    // (Seeding, which writes no paired runs, owns no node keys: it writes
    // into an empty container, where the content's covered values are the
    // cursor's, see insert.)
    let own = this.pairs(SEGMENT_KEY) ? this.ownNodeKeys(f) : null;
    if (fresh) {
      own = this.addHeldOver(f, own);
    }
    const negated = this.insertFormats(f, own);
    const item = this.newItem(content);
    this.right = item;
    this.forward();
    if (marker) {
      negated.delete(TYPE_KEY);
      negated.delete(SEGMENT_KEY);
    }
    this.insertNegatedFormats(negated);
    return item;
  }

  /**
   * The text of a node new in the write (`fresh`, see Writer's $insertAtoms)
   * gets a paired run of its own for each key it gives a value (not null)
   * that equals what the editor shows at the cursor only while a
   * composition holds changes back: a held change's run of that key is open
   * there (a collaborator's unbold of the text composed in, written as a
   * null run), or the shown value comes from a format item a held change
   * deleted (an unbold, or the undo of a bold, that removed the bold run's
   * items, which the hold keeps showing, see Hidden#keep). Stored without a
   * run of its own, the text would lose the value once the hold ends. The
   * format given to the new node is the node's own, not one it inherited:
   * its run keeps it after the hold, as on a client that held nothing. Text typed into a node
   * that existed before, and old characters written again, inherit as
   * before (they are not fresh).
   */
  private addHeldOver(
    f: Record<string, unknown>,
    own: Set<string> | null,
  ): Set<string> | null {
    const hidden = this.hidden;
    if (hidden === null) {
      return own;
    }
    // The keys that could take a run of their own: given a value that is
    // what the cursor shows (only those are looked up below).
    let candidate = false;
    for (const key in f) {
      const val = f[key];
      if (
        val !== null &&
        this.pairs(key) &&
        equalFormatValue(this.formats.get(key) ?? null, val)
      ) {
        candidate = true;
        break;
      }
    }
    if (!candidate) {
      return own;
    }
    const over = this.heldOpenKeys(hidden);
    // The keys whose shown value comes from a format item a held change
    // deleted (see Hidden#keep): once the hold ends, that value is gone.
    if (hidden.keepsAny()) {
      this.sources.forEach((source, key) => {
        if (hidden.keeps(source)) {
          over.add(key);
        }
      });
    }
    let out = own;
    for (const key of over) {
      const val = key in f ? f[key] : null;
      if (
        val === null ||
        !this.pairs(key) ||
        !equalFormatValue(this.formats.get(key) ?? null, val)
      ) {
        continue;
      }
      out = out === null ? new Set() : new Set(out);
      out.add(key);
    }
    return out;
  }

  /**
   * The runs held changes opened before the cursor in its container and did
   * not end before it (opener id to key), and the item the walk that found
   * them stopped at: the next call goes on from there (a write's cursor only
   * moves forward), so the container is walked once (see heldOpenKeys).
   */
  private heldOpen: {open: Map<string, string>; at: Item | null} | null = null;

  /**
   * The keys of the runs held changes opened before the cursor in its
   * container and did not end before it (see addHeldOver).
   */
  private heldOpenKeys(hidden: Hidden): Set<string> {
    let state = this.heldOpen;
    if (state !== null) {
      // Go on from where the last walk stopped, if the cursor is at or past
      // it; otherwise walk again from the start.
      let reach = state.at;
      while (reach !== null && reach !== this.right) {
        reach = reach.right as Item | null;
      }
      if (reach !== this.right) {
        state = null;
      }
    }
    if (state === null) {
      state = {at: this.parent._start, open: new Map()};
    }
    for (
      let it = state.at;
      it !== null && it !== this.right;
      it = it.right as Item | null
    ) {
      if (!isFormat(it) || !hidden.hides(it)) {
        continue;
      }
      if (isEndValue(valueOf(it))) {
        const target = endTarget(it);
        if (target !== null) {
          state.open.delete(`${target.client}:${target.clock}`);
        }
      } else {
        state.open.set(`${it.id.client}:${it.id.clock}`, keyOf(it));
      }
    }
    state.at = this.right;
    this.heldOpen = state;
    return new Set(state.open.values());
  }

  /**
   * Insert content with the formats current at the cursor (no format items).
   */
  insertPlain(content: ContentString | ContentType): Item {
    if (!this.writesPaired()) {
      // Seeding: a unit with no covered value (see insert).
      this.seedBoundary(new Map());
    }
    const item = this.newItem(content);
    this.right = item;
    this.forward();
    if (!this.writesPaired()) {
      seedRunsOf(this.parent).last = item;
    }
    return item;
  }

  /**
   * Delete `n` content units. The format items around and inside them stay:
   * a concurrent writer that has not seen the delete relies on them, and an
   * undo of the delete brings the content back between them (D24, D86).
   * A stored element no editor shows (see leftOut) that the delete meets
   * before its last unit goes with it, uncounted: left in place, one would
   * end up beside other text (the next line's, where a whole line goes), and
   * its text, arriving late or brought back by an undo, would show there.
   */
  delete(n: number): void {
    while (n > 0 && this.right !== null) {
      const item = this.right;
      if (this.counts(item)) {
        if (n < item.length) {
          this.split(item, n);
        }
        n -= item.length;
        deleteItemIn(this.view, item, this.tr);
      } else if (
        this.leftOut !== null &&
        isLiveContent(this.view, item) &&
        this.leftOut(item)
      ) {
        deleteItemIn(this.view, item, this.tr);
      }
      this.forward();
    }
  }

  /**
   * Delete the elements no editor shows (see leftOut) from the cursor up to
   * `stop` (exclusive), without moving: where a delete reached the end of
   * old content, they would otherwise stay before the next content (see
   * delete).
   */
  deleteLeftOutBefore(stop: Item | null): void {
    const leftOut = this.leftOut;
    if (leftOut === null) {
      return;
    }
    for (let it = this.right; it !== null && it !== stop; it = it.right) {
      if (isLiveContent(this.view, it) && leftOut(it)) {
        deleteItemIn(this.view, it, this.tr);
      }
    }
  }

  /**
   * Whether format item `item` is one this client wrote, before this
   * transaction, right next to text of its own in the same insert: the null
   * right before the text (`before`: the text's origin is the null) or the
   * restore right after it (the restore's origin is the text's last unit).
   */
  private isOwnInsertFormat(item: Item, before: boolean): boolean {
    const doc = this.tr.doc;
    const client = doc.clientID;
    if (item.id.client !== client || this.tr.insertSet.hasId(item.id)) {
      return false;
    }
    const clock = before ? item.id.clock + item.length : item.id.clock - 1;
    if (clock < 0 || clock >= doc.store.getClock(client)) {
      return false;
    }
    const text = doc.store.getItem(createID(client, clock));
    if (!(text instanceof Item) || text.content instanceof ContentFormat) {
      return false;
    }
    const origin = before ? text.origin : item.origin;
    const want = before ? item.id.clock + item.length - 1 : clock;
    return origin !== null && origin.client === client && origin.clock === want;
  }

  /**
   * Whether `last` may end the format change `first` was written by: one
   * client wrote both, `first` before this transaction and before `last`,
   * and no content between them (a format change writes format items only).
   */
  private oneFormatWrite(first: Item, last: Item): boolean {
    const {client} = first.id;
    if (
      last.id.client !== client ||
      last.id.clock <= first.id.clock ||
      this.tr.insertSet.hasId(first.id)
    ) {
      return false;
    }
    const store = this.tr.doc.store;
    let steps = 0;
    for (let clock = first.id.clock + first.length; clock < last.id.clock; ) {
      const struct = store.getItem(createID(client, clock));
      if (
        !(struct instanceof Item) ||
        !(struct.content instanceof ContentFormat) ||
        ++steps > 64
      ) {
        return false;
      }
      clock = struct.id.clock + struct.length;
    }
    return true;
  }

  /**
   * Apply `formats` to the next `n` content units, as Yjs' formatText does,
   * except that the range is bounded by items of its own, next to its content.
   * The rules:
   *
   * 1. Inside the range, it removes the items of the keys it changes and no
   *    other item. Before the range's first content it removes only the earlier
   *    items of a key whose value it opens there, which the last one overrides.
   * 2. It keeps the closer of the content before the range (Yjs removes it
   *    to extend that run over the range), and, of each key whose value it
   *    opens before the range's first content, the last item there, and opens
   *    that value right after it, before the content (Yjs removes that item
   *    too). Why: a peer that typed before the range without its format
   *    restores the format it saw after its text, and an opener where the
   *    range's old items were, before that text, was overridden by that restore
   *    (a comment resolved while a peer typed before a space put another
   *    comment on the space); and an undo of the change brought a removed item
   *    back before what a collaborator wrote after it meanwhile (a
   *    collaborator's removal of the value before the range restores it right
   *    before the opener, and once the undo brought the removed item back
   *    before that restore, the range's content took that value).
   * 3. At the end, it keeps an item after the range that gives the content
   *    after it the range's value (Yjs removes it to join the two runs), and
   *    closes the range where its value ends: with the value from before (Yjs'
   *    restore), except where the next item of the key, before the content
   *    after the range, ends another change: one whose client wrote the live
   *    item that gave the range its old value there, with no content between
   *    that item and the next one (a format change writes format items only),
   *    or one of whose items of the key the walk over the range passed, live
   *    before this write (this write may delete it) or deleted before it with
   *    that next item's value (a change that removed a value by deleting its
   *    opener restores it after its range). There it closes with that item's
   *    value in an item of its own, with that item itself where its value is
   *    the value from before, or not at all where it is the range's value. Why:
   *    the range or its neighbour relies on an item the other's writer may
   *    remove (bold removed from a word while a peer typed plain text inside it
   *    came back on everything after the word when the removal dropped the
   *    word's closer), and a restore of the value another change gave must not
   *    outlive that change's undo (a color undone after a collaborator
   *    recolored the end of its range came back on the text after). The client
   *    id stands for the change, and the cursor cannot tell two changes of one
   *    client apart; the rest is what tells them apart: an item before the
   *    range with content written after it, an item this write made, or one
   *    deleted before it with another value is no evidence (a format change of
   *    the space between two runs one client wrote, by the client that wrote
   *    the run after it, or past a comment that client had resolved, closed
   *    with nothing or with that run's value, and a collaborator's removal of
   *    that value from the run left it there).
   * 4. Where a key it changes is one of several of a family (see
   *    formatFamily), it writes the key's value again right before the content
   *    after each boundary of another key of the family inside the range, after
   *    every item there, where the key's old value there is not null and
   *    another. Why: a peer that typed at such a boundary without the key
   *    restores the key's old value after its text, before the family's items
   *    there (see minimizeFormatChanges), so a comment resolved over two
   *    characters while a peer typed plain text between them came back on the
   *    second. A key whose old value there is null is restored by no one.
   * 5. Where it restores a value (at the end of the range, as after
   *    inserted text, see insertNegatedFormats) whose run another client's
   *    change opened (see runOpener), and the item that ends the restored run
   *    is that change's own end of the run (see changeEnd), it writes a null
   *    of its own right after that end. Why: that end can go while the
   *    restore stays, as the undo of that change deletes it and a concurrent
   *    delete could drop it (before deletes kept every item they leave, see
   *    delete), and the restored value ran on to the end of the
   *    document (a format undone while a collaborator typed plain text inside
   *    it, pasted a list there or removed it from part of the range; a
   *    comment undone while a collaborator typed right after it where another
   *    comment ended; a comment whose end a long offline peer's delete
   *    dropped while a collaborator pasted inside it). Right after the end,
   *    not before it: text a collaborator types at the end of the run at the
   *    same time lands before the end, inside the run, and keeps the run's
   *    value. A null by which a change made text inside the run plain (typed
   *    plain text, a removal) is no such end: the undo of that change brings
   *    the value back after it. Likewise, where the run this write opens (its
   *    range's value, or inserted text's) ends at another client's change end
   *    that it reuses as its own closer, it writes a null of its own right
   *    after it (a link a collaborator undid while another linked the text
   *    up to its end ran on to the end of the document).
   */
  format(n: number, formats: Record<string, unknown>): void {
    let cov: Record<string, unknown> | null = null;
    let unc: Record<string, unknown> | null = null;
    for (const key in formats) {
      if (this.pairs(key)) {
        (cov ??= {})[key] = formats[key];
      } else {
        (unc ??= {})[key] = formats[key];
      }
    }
    if (cov === null) {
      this.formatPlain(n, formats);
      return;
    }
    // Paired runs: the uncovered keys as main writes them, then, from the
    // same start, the covered keys as paired runs.
    if (unc !== null) {
      const startLeft = this.left;
      const startFormats = new Map(this.formats);
      const startSources = new Map(this.sources);
      this.formatPlain(n, unc);
      this.left = startLeft;
      this.right = startLeft === null ? this.parent._start : startLeft.right;
      this.formats = new Map(startFormats);
      this.sources.clear();
      startSources.forEach((v, k) => this.sources.set(k, v));
    }
    this.formatCovered(n, cov);
  }

  /**
   * Apply covered `formats` to the next `n` content units as paired runs
   * (layout 3). Per key:
   *
   * 1. It deletes the runs whose content it wholly formats: any
   *    client's paired run that holds at least one content item of the range
   *    and whose every live content item is content this change formats
   *    (counted over every live countable item: held and unread content
   *    counts as not formatted), and every empty paired run strictly inside
   *    the range; but not a run whose interval holds a clearer, a held item
   *    or an unpaired item of the key the change keeps (deleting it would
   *    change how far that item reaches). It deletes every unpaired item of
   *    the key in the region (from right after the live content before the
   *    range to right before the live content after it) whose entry, in the
   *    fold before the change, leaves the stack inside the region, so
   *    deleting it changes nothing outside. A held item stays. Nothing is
   *    restored or copied.
   * 2. Where any content of the range then shows another value, it writes
   *    its value over the whole range as disjoint paired segments, split at
   *    every retained paired opener, kept unpaired item, clearer and held
   *    item of the key inside the range, and at held or unread content. Kept
   *    unpaired items reach past the region, so they are never shadowed:
   *    such a value keeps its extent past the range, its author's undo
   *    removes exactly its own run, and an end that arrives later closes its
   *    run where it always would. Before the first content the overlay nests
   *    above kept items.
   * 3. Placement: an opener right before its segment's first content; a text
   *    format's or set member's last end after the format items that follow
   *    the last content, passing over paired ends and openers of the key
   *    and stopping before its first unpaired item, clearer or held item
   *    there (a collaborator typing at the end of the run at the same time
   *    lands inside it, whatever the client ids); a node's own keys and a
   *    wrapper end right after the content (with the same stops), or where a
   *    run this change deleted ended. Only paired items are written.
   */
  private formatCovered(n: number, formats: Record<string, unknown>): void {
    if (n <= 0) {
      return;
    }
    const startLeft = this.left;
    // Nothing below changes the cursor's formats or sources before it is
    // moved past the range at the end: they are the start's.
    const startFormats = this.formats;
    // The range: the items from the cursor to its last content unit, then
    // the format and deleted items up to the next live content.
    const span: Item[] = [];
    const contents: Item[] = [];
    let left = n;
    let it = this.right;
    for (; it !== null && left > 0; it = it.right) {
      if (this.counts(it)) {
        if (left < it.length) {
          this.split(it, left);
        }
        left -= it.length;
        contents.push(it);
      }
      span.push(it);
    }
    const lastContent = contents[contents.length - 1];
    if (lastContent === undefined) {
      return;
    }
    const contentSet = new Set(contents);
    for (; it !== null && !isLiveContent(this.view, it); it = it.right) {
      span.push(it);
    }
    const keys = Object.keys(formats);
    const lastAt = span.indexOf(lastContent);
    const firstAt = span.indexOf(contents[0]);
    const spanIndex = new Map<Item, number>();
    span.forEach((x, i) => spanIndex.set(x, i));
    /** Whether `x` is a live item of `key`, as this write sees it. */
    const isKeyItem = (x: Item, key: string): boolean =>
      !isGoneIn(this.view, x) &&
      isFormat(x) &&
      keyOf(x) === key &&
      !this.isHeldFormat(x);
    /** An unpaired item or an invalid end of its key: a boundary. */
    const isBoundary = (x: Item): boolean => {
      const v = valueOf(x);
      if (isEndValue(v)) {
        return !isValidEnd(x, this.stored());
      }
      return v === null || !this.pairedShown(x);
    };
    // The before-fold, per key (one snapshot before any mutation),
    // as the document reads once it records layout 3 (this change writes
    // the record before its first paired item): with run stacks, also in a
    // document still below layout 3. It gives the unpaired items whose entry
    // leaves the stack inside the region (deleted, step 1) and the
    // clearers (ends naming no run open at their position, kept).
    const leaving = new Map<string, Set<Item>>();
    const clearers = new Set<Item>();
    for (const key of keys) {
      const sim = keySlice(startFormats, key);
      const leaves = new Set<Item>();
      let pending: Item[] = [];
      for (const x of span) {
        if (!isFormat(x) || keyOf(x) !== key || isGoneIn(this.view, x)) {
          // Other keys never change this key's stack.
          continue;
        }
        if (this.isHeldFormat(x)) {
          continue;
        }
        if (isEndValue(valueOf(x))) {
          const target = isValidEnd(x, this.stored()) ? endTarget(x) : null;
          if (
            target === null ||
            !isOnStack(sim, key, target.client, target.clock)
          ) {
            clearers.add(x);
          }
        }
        this.stepShown(sim, x);
        if (!isEndValue(valueOf(x)) && isBoundary(x)) {
          pending.push(x);
        }
        if (pending.length > 0) {
          pending = pending.filter(u => {
            if (isOnStack(sim, key, u.id.client, u.id.clock)) {
              return true;
            }
            leaves.add(u);
            return false;
          });
        }
      }
      leaving.set(key, leaves);
    }
    /** A held item of `key` the write's view still has. */
    const isHeldKeyItem = (x: Item, key: string): boolean =>
      isFormat(x) &&
      keyOf(x) === key &&
      !isGoneIn(this.view, x) &&
      this.isHeldFormat(x);
    /** A clearer, or an invalid end (which names no open run either). */
    const isClearer = (x: Item): boolean =>
      clearers.has(x) ||
      (isEndValue(valueOf(x)) && !isValidEnd(x, this.stored()));
    /**
     * Whether the interval of the run `opener` opened, up to its end `end`,
     * holds a clearer, a held item, or an unpaired item of `key` this change
     * keeps: deleting the run would change how far that item reaches
     * (step 1).
     */
    const shields = (opener: Item, end: Item, key: string): boolean => {
      const leaves = leaving.get(key)!;
      for (let x = opener.right; x !== null && x !== end; x = x.right) {
        if (!isFormat(x) || keyOf(x) !== key || isGoneIn(this.view, x)) {
          continue;
        }
        if (this.isHeldFormat(x)) {
          return true;
        }
        if (isEndValue(valueOf(x))) {
          if (isClearer(x)) {
            return true;
          }
        } else if (isBoundary(x) && !leaves.has(x)) {
          return true;
        }
      }
      return false;
    };
    // The deletion plan: per key, the runs this change wholly formats the
    // content of (step 1) and the empty runs inside the range, unless a run
    // shields an item it keeps.
    const plan: [key: string, opener: Item, ends: Item[]][] = [];
    for (const key of keys) {
      for (let si = 0; si <= lastAt; si++) {
        const s = span[si];
        const v = isKeyItem(s, key) ? valueOf(s) : null;
        if (v === null || isEndValue(v) || !this.pairedShown(s)) {
          continue;
        }
        // Every live end of the run, held ones too: a run deleted goes with
        // all its ends in the document (one left behind would name nothing).
        // The plan never takes a run whose interval or end the hold holds
        // (see wholeRunEnd, emptyRunEnd and shields).
        const ends = liveEndsOf(s, this.stored());
        const end =
          this.wholeRunEnd(s, ends, contentSet) ??
          (si > firstAt
            ? this.emptyRunEnd(s, ends, key, lastAt, spanIndex)
            : null);
        if (end !== null && !shields(s, end, key)) {
          // Its opener and its first valid live end: a later end naming
          // it stays (it then reads as an invalid end, which clears unpaired
          // runs as it did while the run was open).
          plan.push([key, s, [end]]);
        }
      }
    }
    // Every unpaired item of a key in the region whose entry leaves the
    // stack inside it: its effect reaches no live content outside the range
    // (step 1). Every other unpaired item stays (inside the range
    // it is a boundary), and so does every clearer.
    const planned = new Set(plan.flatMap(([, o, e]) => [o, ...e]));
    for (const key of keys) {
      for (const s of leaving.get(key)!) {
        if (!planned.has(s)) {
          plan.push([key, s, []]);
          planned.add(s);
        }
      }
    }
    // Per key, the ends of the runs this change deletes that lay after the
    // range's last content: a new run of the key ends where they ended.
    const replacedEnds = new Map<string, Item[]>();
    for (const [key, s, ends] of plan) {
      deleteItemIn(this.view, s, this.tr);
      for (const e of ends) {
        deleteItemIn(this.view, e, this.tr);
        if ((spanIndex.get(e) ?? -1) > lastAt) {
          let list = replacedEnds.get(key);
          if (list === undefined) {
            list = [];
            replacedEnds.set(key, list);
          }
          list.push(e);
        }
      }
    }
    for (const key of keys) {
      const want = formats[key] ?? null;
      // Does any content of the range show another value now?
      const sim = keySlice(startFormats, key);
      let differs = false;
      for (const s of span) {
        if (isFormat(s)) {
          if (
            keyOf(s) === key &&
            !isGoneIn(this.view, s) &&
            !this.isHeldFormat(s)
          ) {
            this.stepShown(sim, s);
          }
        } else if (
          contentSet.has(s) &&
          !equalFormatValue(sim.get(key) ?? null, want)
        ) {
          differs = true;
          break;
        }
        if (s === lastContent) {
          break;
        }
      }
      if (!differs) {
        continue;
      }
      const extending = extendsPastContent(key);
      // Where the last segment ends (step 3): after the format
      // items that follow the range's last content, passing over paired
      // ends and paired openers (such a run is pushed above this one and
      // survives its end), and before the first unpaired item, clearer or
      // held item of the key there (a node key's or link's right after the content,
      // or where a run this change deleted ended).
      const replaced = (replacedEnds.get(key) ?? []).reduce<Item | null>(
        (first, e) =>
          first === null || spanIndex.get(e)! < spanIndex.get(first)!
            ? e
            : first,
        null,
      );
      let at: Item = lastContent;
      let stop: Item | null = null;
      for (let x = lastContent.right; x !== null; x = x.right) {
        if (!spanIndex.has(x) || (!extending && x === replaced)) {
          break;
        }
        if (
          isHeldKeyItem(x, key) ||
          (isKeyItem(x, key) &&
            (isEndValue(valueOf(x)) ? isClearer(x) : isBoundary(x)))
        ) {
          stop = x;
          break;
        }
        if (
          !extending &&
          (isGoneIn(this.view, x) || !isFormat(x) || !keys.includes(keyOf(x)))
        ) {
          break;
        }
        at = x;
      }
      if (
        !extending &&
        stop === null &&
        replaced !== null &&
        replaced.left !== null
      ) {
        at = replaced.left;
      }
      const stored = (want === null ? NULL_RUN : want) as object;
      // Disjoint segments: the current one ends right before each boundary
      // (a retained paired opener, a kept unpaired item, a clearer, a held
      // item of the key, held or unread content), and the next one opens right after the boundary
      // (the last of consecutive ones), when content of the range follows.
      // So the only gaps are the boundary items themselves: content between
      // them and the next content (deleted text an undo brings back) stays
      // inside a segment, as it is inside the range. The first segment opens
      // right before the range's first content. A segment never holds no
      // content. An identity client writes only paired items:
      // each opener is written when its segment closes, right before its end.
      let open = null as [after: Item | null, before: Item | null] | null;
      let reopenAfter = null as Item | null;
      const writeOpener = (after: Item | null, before: Item | null): Item => {
        this.beforePairedItem();
        return this.insertAfterRaw(
          after,
          before,
          new ContentFormat(key, stored),
        );
      };
      const close = (boundary: Item) => {
        if (open !== null) {
          const opener = writeOpener(open[0], open[1]);
          const before = boundary.left!;
          this.writeEndAt(key, opener, before, before.right);
          open = null;
        }
        reopenAfter = boundary;
      };
      const openAt = (after: Item | null, before: Item | null) => {
        open = [after, before];
      };
      for (let si = firstAt; si <= lastAt; si++) {
        const s = span[si];
        if (contentSet.has(s)) {
          if (open === null) {
            if (reopenAfter === null) {
              openAt(s.left, s);
            } else {
              openAt(reopenAfter, reopenAfter.right);
            }
          }
          continue;
        }
        if (s.deleted && !(s.content instanceof ContentFormat)) {
          // Possible content: deleted text, or a tombstone of unknown kind
          // (`countable` is not kept through encoding): an undo can bring it
          // back inside the range, so a segment covers it.
          if (open === null && reopenAfter !== null) {
            openAt(reopenAfter, reopenAfter.right);
          }
          continue;
        }
        if (!s.deleted && s.countable) {
          // held or unread content: the change does not take it
          close(s);
        } else if (
          isHeldKeyItem(s, key) ||
          (isKeyItem(s, key) && (!isEndValue(valueOf(s)) || isClearer(s)))
        ) {
          // a retained paired opener, a kept unpaired item (its effect
          // reaches past the region), a clearer, or a held item of the key
          close(s);
        }
      }
      if (open !== null) {
        const [after, before] = open as [Item | null, Item | null];
        const opener = writeOpener(after, before);
        this.writeEndAt(key, opener, at, at.right);
      }
    }
    // Leave the cursor after the range's content and the ends written there,
    // with the formats there.
    this.left = startLeft;
    this.right = startLeft === null ? this.parent._start : startLeft.right;
    while (this.right !== null && this.right !== lastContent) {
      this.forward();
    }
    if (this.right === lastContent) {
      this.forward();
    }
    while (
      this.right !== null &&
      isFormat(this.right) &&
      this.tr.insertSet.hasId(this.right.id)
    ) {
      this.forward();
    }
  }

  /**
   * The first valid live end of the EMPTY paired run `opener` opened (no
   * live content item between them, held and unread content included), when
   * that end lies before the range's last content (`lastAt`, by
   * `spanIndex`) and its interval holds no clearer (an invalid end) and no
   * held item of `key` (step 1).
   * Null otherwise. The caller checks the opener lies after the range's
   * first content.
   */
  private emptyRunEnd(
    opener: Item,
    ends: Item[],
    key: string,
    lastAt: number,
    spanIndex: Map<Item, number>,
  ): Item | null {
    if (ends.length === 0 || this.isHeldFormat(opener)) {
      return null;
    }
    for (let x = opener.right; x !== null; x = x.right) {
      const at = spanIndex.get(x);
      if (at === undefined || at >= lastAt) {
        return null;
      }
      if (ends.includes(x)) {
        return this.isHeldFormat(x) ? null : x;
      }
      if (x.countable && (!x.deleted || !isGoneIn(this.view, x))) {
        return null;
      }
      if (isFormat(x) && keyOf(x) === key && !isGoneIn(this.view, x)) {
        // a held item of the key, or a clearer (step 1)
        if (
          this.isHeldFormat(x) ||
          (isEndValue(valueOf(x)) && !isValidEnd(x, this.stored()))
        ) {
          return null;
        }
      }
    }
    return null;
  }

  /**
   * The first valid live end of the paired run `opener` opened (among its
   * live ends `ends`), where this change formats every live content item
   * between them, and at least one: counted over every live countable item,
   * so held content (not in `formatted`) and content the write does not see
   * yet (an unread change's) count as not formatted. Null otherwise, and
   * where the opener or that end is held (a held item is never deleted).
   */
  private wholeRunEnd(
    opener: Item,
    ends: Item[],
    formatted: Set<Item>,
  ): Item | null {
    if (ends.length === 0 || this.isHeldFormat(opener)) {
      return null;
    }
    let holds = false;
    for (let x = opener.right; x !== null; x = x.right) {
      if (ends.includes(x)) {
        return holds && !this.isHeldFormat(x) ? x : null;
      }
      if ((x.deleted && isGoneIn(this.view, x)) || !x.countable) {
        continue;
      }
      if (!formatted.has(x)) {
        return null;
      }
      holds = true;
    }
    // an end before its opener, or in another container: not this run's
    return null;
  }

  /**
   * Write, between `left` and `right`, the end of the paired run `opener`
   * opened; returns it.
   */
  private writeEndAt(
    key: string,
    opener: Item,
    left: Item,
    right: Item | null,
  ): Item {
    const doc = this.tr.doc;
    if (
      __DEV__ &&
      liveEndsOf(opener, this.stored()).some(e => isValidEnd(e, this.stored()))
    ) {
      throw new Error(
        `@lexical/y: a second end for format item ${opener.id.client}:${opener.id.clock}`,
      );
    }
    const id = createID(doc.clientID, doc.store.getClock(doc.clientID));
    const end = this.insertAfterRaw(
      left,
      right,
      new ContentFormat(key, endValue(id, opener.id) as unknown as object),
    );
    noteEnd(doc, end, 'written');
    noteHolder(end);
    return end;
  }

  /** Paired runs: link a new format item between `left` and `right`. */
  private insertAfterRaw(
    left: Item | null,
    right: Item | null,
    content: ContentFormat,
  ): Item {
    const doc = this.tr.doc;
    checkLinkable(left, right, this.parent);
    const item = new Item(
      createID(doc.clientID, doc.store.getClock(doc.clientID)),
      left,
      left && left.lastId,
      right,
      right && right.id,
      this.parent,
      null,
      content,
    );
    owned(doc, () => item.integrate(this.tr, 0));
    return item;
  }

  private formatPlain(n: number, formats: Record<string, unknown>): void {
    const passed = new Set<string>();
    this.passed = n > 0 ? passed : null;
    this.minimizeFormatChanges(formats);
    const before = new Map(this.formats);
    // The keys whose value the range opens, before its first content.
    const open = new Set<string>();
    // The value of each key to restore after the range.
    const negated: Formats = new Map();
    for (const key in formats) {
      const current = this.formats.get(key) ?? null;
      if (!equalFormatValue(current, formats[key])) {
        negated.set(key, current);
        open.add(key);
      }
    }
    // Keys whose value at the start of the range this write opens.
    const opened = new Set(open);
    // Of each key this write changes, the live item that gave it its value
    // before this write, up to the range's end (see rule 3).
    const oldSource = new Map<string, Item>();
    for (const key in formats) {
      const source = this.sources.get(key);
      if (source !== undefined) {
        oldSource.set(key, source);
      }
    }
    // Keys whose value this write writes again at a boundary in the range,
    // and the value each key changed had at the cursor before this write.
    const restate = new Set<string>();
    const old = new Map<string, unknown>();
    for (const key in formats) {
      old.set(key, before.get(key) ?? null);
    }
    let inRange = false;
    // The last item of each key this write changes before the range's first
    // content: kept.
    const atStart = new Map<string, Item>();
    loop: while (
      this.right !== null &&
      (n > 0 ||
        (negated.size > 0 &&
          (isGoneIn(this.view, this.right) || isFormat(this.right))))
    ) {
      const r = this.right;
      if (this.isHeldFormat(r)) {
        this.forward();
        continue;
      }
      if (!isGoneIn(this.view, r)) {
        if (isFormat(r)) {
          const {key, value} = r.content as ContentFormat;
          const attr = formats[key];
          if (attr !== undefined) {
            old.set(key, value);
            if (n > 0) {
              oldSource.set(key, r);
            }
            const prev = before.get(key) ?? null;
            if (!inRange && n > 0 && opened.has(key)) {
              // Rules 1 and 2. Before the range's first content, of a key
              // whose value this write opens there: kept, the last of its
              // key there (an earlier one, which it overrides, is removed),
              // and the range's value opened after it, before that content.
              const earlier = atStart.get(key);
              if (earlier !== undefined) {
                deleteItemIn(this.view, earlier, this.tr);
              }
              atStart.set(key, r);
              if (equalFormatValue(attr, value)) {
                negated.delete(key);
              } else {
                negated.set(key, value);
              }
              this.forward();
              continue;
            }
            if (
              !inRange &&
              n > 0 &&
              !opened.has(key) &&
              prev !== null &&
              equalFormatValue(prev, attr) &&
              this.isOwnInsertFormat(r, true)
            ) {
              // The null this client's own earlier insert wrote before its
              // text, which the range covers with the value before it:
              // removed, as Yjs' formatText does, so the run goes on over
              // the range and no one relies on it (#9671).
              deleteItemIn(this.view, r, this.tr);
              negated.set(key, value);
              this.forward();
              continue;
            }
            if (
              !inRange &&
              !opened.has(key) &&
              prev !== null &&
              !equalFormatValue(prev, value)
            ) {
              // Rule 2. The closer of the content before the range: kept,
              // and the range's value opened before its content.
              opened.add(key);
              open.add(key);
              this.forward();
              negated.set(key, value);
              continue;
            }
            if (equalFormatValue(attr, value)) {
              if (n === 0) {
                if (attr !== null) {
                  if (this.isOwnInsertFormat(r, false)) {
                    // The restore this client's own earlier insert wrote
                    // after its text, with the range's value: removed, as
                    // Yjs' formatText does, the runs joined (#9671).
                    negated.delete(key);
                    deleteItemIn(this.view, r, this.tr);
                    this.forward();
                    continue;
                  }
                  // Rule 3. The opener of the content after the range: kept,
                  // and the range closed before it.
                  break loop;
                }
                // A closer that ends the content before it: kept.
                negated.delete(key);
                this.forward();
                continue;
              }
              negated.delete(key);
            } else {
              if (n === 0) {
                break loop;
              }
              negated.set(key, value);
            }
            deleteItemIn(this.view, r, this.tr);
          } else {
            if (inRange && n > 0) {
              // Rule 4. A boundary of another key of a family this write
              // changes, inside the range: the value of a key whose old
              // value there was not null, and was another, is written there
              // again.
              const family = formatFamily(key);
              for (const changed in formats) {
                if (changed !== key && formatFamily(changed) === family) {
                  restate.add(changed);
                }
              }
            }
          }
        } else if (isLiveContent(this.view, r)) {
          if (!inRange) {
            inRange = true;
            // Rule 2. The range's value, opened right before its first
            // content.
            for (const key of open) {
              const attr = formats[key];
              if (!equalFormatValue(this.formats.get(key) ?? null, attr)) {
                this.right = this.newItem(
                  new ContentFormat(key, attr as object),
                );
                this.forward();
              }
            }
          } else if (restate.size > 0) {
            // Right before the content after that boundary, after every
            // item there.
            for (const key of restate) {
              const was = old.get(key) ?? null;
              if (was !== null && !equalFormatValue(was, formats[key])) {
                this.right = this.newItem(
                  new ContentFormat(key, formats[key] as object),
                );
                this.forward();
              }
            }
            restate.clear();
          }
          if (this.counts(r)) {
            if (n < r.length) {
              getItemCleanStart(this.tr, createID(r.id.client, r.id.clock + n));
            }
            n -= Math.min(n, r.length);
            if (n === 0) {
              this.passed = null;
            }
          }
        }
      }
      this.forward();
    }
    // Rule 3, the range's end. Where the next item of a key there, before the
    // content after the range, ends another change (see oldSource and
    // `passed`; that change's own end: the item gives the content after the
    // range the value it had before that change),
    // the range closes with that item's value, in an item of its own (an
    // undo of that change removes it with the rest of that change), or not
    // at all where that is the range's value, or with that item itself
    // where its value is the value from before (the restore reuses it).
    const ahead = new Map<string, Item>();
    const copiedEnds: Item[] = [];
    for (
      let it = this.right;
      it !== null && !isLiveContent(this.view, it);
      it = it.right
    ) {
      if (!isGoneIn(this.view, it) && isFormat(it) && !ahead.has(keyOf(it))) {
        ahead.set(keyOf(it), it);
      }
    }
    for (const key of [...negated.keys()]) {
      const next = ahead.get(key);
      if (next === undefined) {
        continue;
      }
      const value = valueOf(next);
      const of = `${key}\u0000${next.id.client}`;
      const source = oldSource.get(key);
      if (
        passed.has(of) ||
        passed.has(`${of}\u0000${JSON.stringify(value)}`) ||
        (source !== undefined && this.oneFormatWrite(source, next))
      ) {
        if (equalFormatValue(value, formats[key] ?? null)) {
          negated.delete(key);
        } else if (!equalFormatValue(value, negated.get(key) ?? null)) {
          negated.delete(key);
          this.right = this.newItem(new ContentFormat(key, value as object));
          if (value === null) {
            formatClosers.add(this.right);
          }
          this.forward();
          // Rule 5 for this copy of another client's opener: it restates
          // that opener's run, whose change's undo deletes the opener and
          // the run's end (see changeEnd) but not the copy, which would run
          // on over the text after it (#9622). End it right after that end
          // too, with a null of this write's own.
          if (value !== null && next.id.client !== this.tr.doc.clientID) {
            const end = changeEnd(this.tr.doc, next);
            if (
              end !== null &&
              !isGoneIn(this.view, end) &&
              valueOf(end) === null
            ) {
              copiedEnds.push(end);
            }
          }
        }
      }
    }
    this.passed = null;
    this.insertNegatedFormats(negated, true);
    for (const end of copiedEnds) {
      formatClosers.add(
        this.insertAfter(
          end,
          new ContentFormat(keyOf(end), null as unknown as object),
        ),
      );
    }
  }
}
