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
  getItemCleanStart,
  Item,
  type Node as YNode,
  type Transaction,
} from '@y/y';

import {runBoundary, type StoredUnit, storedUnit} from './Canonical';
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
  isSeeding,
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
} from './Ident';
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
import {deleteItemIn} from './Seen';
import {
  heldRuns,
  isGoneIn,
  isHeldFormat,
  isHeldFormatIn,
  isKept,
  isLeftOutIn,
  isLiveContent,
  isPassedIn,
  isShownContent,
  type LeftOut,
} from './Shown';

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
 * change writes paired runs (see format). Every name the binding writes is
 * covered (see Ident's covered): a value is only ever written as a paired
 * run, and an item of any other name (a raw writer's) is never written,
 * changed or deleted.
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
 * wrappers: see Cursor#format).
 */
function extendsPastContent(key: string): boolean {
  return key.startsWith(TEXT_FORMAT_PREFIX) || key.startsWith(STATE_PREFIX);
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

  /** The shared root of the cursor's container (see Ident.rootOf). */
  private root: YNode | null = null;
  /** Whether this client's layout record is known to be written. */
  private recorded = false;
  /** Whether the cursor's document is being seeded (see isSeeding). */
  private seed: boolean | null = null;

  /**
   * Whether this cursor writes a seed (see Ident.withSeeding): the content
   * of a pristine root, whose runs are written in the canonical form (see
   * insert) instead of one run per write.
   */
  private seeding(): boolean {
    return (this.seed ??= isSeeding(this.tr.doc));
  }

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
    stepPaired(formats, it, this.shownFold());
  }

  /** Before this write's first paired item (see ensureIdentityRecord). */
  private beforePairedItem(): void {
    if (!this.recorded) {
      this.recorded = true;
      ensureIdentityRecord((this.root ??= rootOf(this.parent)));
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
   * Where `formats` was folded up to, when past `left` (see Seen.frontierOf):
   * until the cursor passes it, the format items it steps over are in
   * `formats` already, so a paired run is not stepped twice; an item of
   * a name that is not covered, which sets itself again, still steps.
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
    return isHeldFormat(item, this.hidden);
  }

  /**
   * Whether the cursor passes over `item` as not there: gone in the write's
   * view, or a format the editor holds back (see Shown.isPassedIn).
   */
  private passes(item: Item): boolean {
    return isPassedIn(this.view, item, this.hidden);
  }

  /**
   * The unit of format items from live format item `item` on, by position,
   * never by which write made them: the items right after it, one after the
   * other, of its family (see formatFamily), up to the first item of
   * another family, a held or gone item, content, or a second item of a key
   * the unit already has (whoever wrote them, whatever their clocks: a
   * closer and the next run's opener of one key are two units, as one
   * write's items of one key never are one). As a whole value's one item
   * would, they change the family's value there together.
   */
  private unitAt(item: Item): Item[] {
    const family = formatFamily(keyOf(item));
    const unit = [item];
    const keys = new Set([keyOf(item)]);
    for (
      let it = item.right;
      it !== null &&
      !this.passes(it) &&
      isFormat(it) &&
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
   * Whether live format item `item` is part of a node's opener, by position
   * and stored pairing, never by which write made the items: the openers
   * from `item` on, before the next content (gone items aside; a held item,
   * an end or a plain null ends the search), reach a live node type or
   * segment opener.
   */
  private opensNode(item: Item): boolean {
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
    const [len, isHidden] = heldRuns(item, hidden)[0];
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
   * unitAt), the value `formats` gives every key of it. Why: an item that
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
      if (this.passes(r)) {
        // a deleted item has no length, and a held format is not there:
        // step over it
      } else if (
        isFormat(r) &&
        covered(keyOf(r)) &&
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
      if (this.passes(x)) {
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
          covered(key) &&
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
    // The value a key has after the unit is what the stack of its runs
    // shows, not the items' raw values.
    const sim = new Map(this.formats);
    for (const it of unit) {
      this.stepShown(sim, it);
    }
    for (const it of unit) {
      after.set(keyOf(it), sim.get(keyOf(it)) ?? null);
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

  /**
   * Before inserted content: open a paired run of its own for each covered
   * key whose value in `formats` is not the one the cursor shows, and for
   * each key in `own` (see ownNodeKeys, addHeldOver). Each is ended after
   * the content (see endInsertRuns). A name that is not covered is never
   * written: the content takes the value the name has at the cursor.
   */
  private openInsertRuns(
    formats: Record<string, unknown>,
    own: Set<string> | null,
  ): void {
    for (const key in formats) {
      if (!covered(key)) {
        continue;
      }
      const val = formats[key];
      const current = this.formats.get(key) ?? null;
      if (!equalFormatValue(current, val) || (own !== null && own.has(key))) {
        this.beforePairedItem();
        const opener = this.newItem(
          new ContentFormat(key, (val === null ? NULL_RUN : val) as object),
        );
        this.openers.set(key, opener);
        markPending(opener);
        this.right = opener;
        this.forward();
      }
    }
  }

  /**
   * After inserted content: end each run the insert opened (see
   * openInsertRuns) with an end naming its opener, in the order they were
   * opened, past the gone and held items right after the content.
   */
  private endInsertRuns(): void {
    while (this.right !== null && this.passes(this.right)) {
      this.forward();
    }
    for (const [key, opener] of this.openers) {
      this.writeEnd(key, opener);
    }
    this.openers.clear();
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
    if (!this.seeding()) {
      return this.insertWithFormats(content, formats, fresh);
    }
    // Seeding (see Ident.withSeeding): the unit's values as canonical runs,
    // written in this pass where the values change (see seedBoundary). Into
    // an empty container, so nothing follows the cursor.
    const seeded = new Map<string, unknown>();
    for (const key in formats) {
      if (covered(key) && formats[key] !== null) {
        seeded.set(key, formats[key]);
      }
    }
    this.seedBoundary(storedUnit(seeded, covered));
    return this.seedUnit(content);
  }

  /** Seeding: write `content` at the cursor, the seed's last unit so far. */
  private seedUnit(content: ContentString | ContentType): Item {
    const item = this.newItem(content);
    this.right = item;
    this.forward();
    seedRunsOf(this.parent).last = item;
    return item;
  }

  /**
   * Seeding: before a unit with covered values `unit`, at the cursor, the
   * ends of the seed's runs that stop there and the openers of the runs
   * that start there (Canonical's runBoundary, the canonical form's rule).
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
        covered(key) &&
        !(key in f) &&
        !(plainText && (key === TYPE_KEY || key === SEGMENT_KEY))
      ) {
        f[key] = null;
      }
    });
    this.minimizeFormatChanges(f);
    let own = this.ownNodeKeys(f);
    if (fresh) {
      own = this.addHeldOver(f, own);
    }
    this.openInsertRuns(f, own);
    const item = this.newItem(content);
    this.right = item;
    this.forward();
    if (marker) {
      // The marker closes the tab's type for good: its `[]` runs get no end.
      this.openers.delete(TYPE_KEY);
      this.openers.delete(SEGMENT_KEY);
    }
    this.endInsertRuns();
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
        covered(key) &&
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
        if (isKept(source, hidden)) {
          over.add(key);
        }
      });
    }
    let out = own;
    for (const key of over) {
      const val = key in f ? f[key] : null;
      if (
        val === null ||
        !covered(key) ||
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
      if (!isHeldFormat(it, hidden)) {
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
    if (this.seeding()) {
      // A unit with no covered value (see insert).
      this.seedBoundary(new Map());
      return this.seedUnit(content);
    }
    const item = this.newItem(content);
    this.right = item;
    this.forward();
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
      } else if (isLeftOutIn(this.view, item, this.leftOut)) {
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
      if (isLeftOutIn(this.view, it, leftOut)) {
        deleteItemIn(this.view, it, this.tr);
      }
    }
  }

  /**
   * Apply `formats` to the next `n` content units as paired runs. A name
   * that is not covered is left as it is (the binding owns none). Per key:
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
  format(n: number, given: Record<string, unknown>): void {
    const formats: Record<string, unknown> = {};
    for (const key in given) {
      if (covered(key)) {
        formats[key] = given[key];
      }
    }
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
    // (The key first: the hold is asked only about items of `key`.)
    const isKeyItem = (x: Item, key: string): boolean =>
      isFormat(x) && keyOf(x) === key && !this.passes(x);
    /** An unpaired item or an invalid end of its key: a boundary. */
    const isBoundary = (x: Item): boolean => {
      const v = valueOf(x);
      if (isEndValue(v)) {
        return !isValidEnd(x, this.stored());
      }
      return v === null || !this.pairedShown(x);
    };
    // The before-fold, per key (one snapshot before any mutation). It
    // gives the unpaired items whose entry leaves the stack inside the
    // region (deleted, step 1) and the clearers (ends naming no run open at
    // their position, kept).
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
      isHeldFormatIn(this.view, x, this.hidden);
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
          if (keyOf(s) === key && !this.passes(s)) {
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
}
