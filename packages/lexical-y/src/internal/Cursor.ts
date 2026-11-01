/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Hidden} from './Hidden';

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
  decodeFormatValue,
  formatFamily,
  MARKER,
  SEGMENT_KEY,
  TYPE_KEY,
  WRAPPER_PREFIX,
} from './Schema';
import {deleteItem, isGone} from './Seen';

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
 * Y.Node#applyDelta), but the items differ: a delete keeps, in the run of
 * deleted content and format items it leaves, a bounded number of the format
 * items Yjs removes as redundant, which concurrent writers rely on (see
 * collapseGap), and a format change keeps the items that bound the content
 * around its range, opens its value next to its content and closes it where
 * the change that gave the range its old value ends (see format), all per
 * family of keys (see formatFamily); an undo keeps some of the closers a
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
function unitFrom(item: Item): Item[] {
  const unit = [item];
  for (
    let prev = item, it = item.right;
    it !== null && !isGone(it) && isFormat(it) && continuesUnit(unit, prev, it);
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
 * The item that ends the run `item`, a format item, opened in the write that
 * made it: the first item of its key, with another value, that its client
 * made after it (one write's items are one after the other in its client's
 * clock order; looked for among the next 64). Null when none is found.
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
 * structs before it, in clock order) of the key `key`, or null.
 */
function lastOwnItemBefore(doc: Doc, item: Item, key: string): Item | null {
  const {client} = item.id;
  let clock = item.id.clock - 1;
  for (let steps = 0; clock >= 0 && steps < 64; steps++) {
    const prev = doc.store.getItem(createID(client, clock));
    if (!(prev instanceof Item)) {
      return null;
    }
    if (prev.content instanceof ContentFormat && prev.content.key === key) {
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
export const isLiveContent = (item: Item): boolean =>
  !isGone(item) && item.countable;

/** An opener of a node type key (`t`) or segment key (`k`). */
function isNodeTypeOpener(content: ContentFormat): boolean {
  return (
    (content.key === TYPE_KEY || content.key === SEGMENT_KEY) &&
    content.value !== null
  );
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
   * Where the run of items without live content that the cursor is in
   * starts (see collapseGap): after this item, or at the parent's start for
   * null. The live content before it, or the item the cursor was made after
   * when it has passed no live content since (and that item is not live).
   */
  private gapStart: Item | null;
  /**
   * The value each key had at gapStart, for the keys whose format items the
   * cursor passed since; any other key still has the value it has at the
   * cursor.
   */
  private readonly gapFormats: Formats = new Map();
  /**
   * The live format item that gave each key its value at the cursor, for
   * the keys whose format items the cursor passed.
   */
  private readonly sources = new Map<string, Item>();
  /**
   * While a format change walks its range (see format, rule 3): the key
   * and client of each format item the cursor passed that this transaction
   * did not make, and the value of those deleted before it.
   */
  private passed: Set<string> | null = null;
  constructor(
    readonly tr: Transaction,
    readonly parent: YNode,
    left: Item | null,
    formats: Formats,
  ) {
    this.left = left;
    this.right = left === null ? parent._start : left.right;
    this.formats = formats;
    this.gapStart = left;
    // Index search markers would not follow these item-level edits.
    if (parent._searchMarker !== null) {
      parent._searchMarker.length = 0;
    }
  }

  /** Whether `item` is a format the editor holds back (see hidden). */
  private isHeldFormat(item: Item): boolean {
    return this.hidden !== null && isFormat(item) && this.hidden.hides(item);
  }

  /** Step over `right`, tracking formats. */
  forward(): void {
    const item = this.right!;
    if (this.isHeldFormat(item)) {
      this.left = item;
      this.right = item.right;
      return;
    }
    if (isLiveContent(item)) {
      this.gapStart = item;
      this.gapFormats.clear();
    } else if (
      this.passed !== null &&
      isFormat(item) &&
      !this.tr.insertSet.hasId(item.id)
    ) {
      const of = `${keyOf(item)}\u0000${item.id.client}`;
      this.passed.add(
        !isGone(item) || this.tr.deleteSet.hasId(item.id)
          ? of
          : `${of}\u0000${JSON.stringify(valueOf(item))}`,
      );
    }
    if (!isGone(item) && isFormat(item)) {
      const {key, value} = item.content as ContentFormat;
      if (!this.gapFormats.has(key)) {
        this.gapFormats.set(key, this.formats.get(key) ?? null);
      }
      this.sources.set(key, item);
      if (value === null) {
        this.formats.delete(key);
      } else {
        this.formats.set(key, value);
      }
    }
    this.left = item;
    this.right = item.right;
  }

  /** Step over format items and deleted items (never over live content). */
  skipNonContent(): void {
    while (this.right !== null && !isLiveContent(this.right)) {
      this.forward();
    }
  }

  /**
   * Whether `item` (live content) counts: split it so that it is all hidden
   * or all shown, and answer whether it is shown.
   */
  private counts(item: Item): boolean {
    if (!isLiveContent(item)) {
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
    item.integrate(this.tr, 0);
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
      if (isGone(r) || this.isHeldFormat(r)) {
        // a deleted item has no length, and a held format is not there:
        // step over it
      } else if (
        isFormat(r) &&
        this.unitGives(r, formats) &&
        (keyOf(r).startsWith(WRAPPER_PREFIX) || !opensNodeRun(r))
      ) {
        // a format that already matches (never an item of another node's
        // opener, its type and segment keys and the formats its write
        // opened with them: content written past it would be inside that
        // node's run, between its opener and its content, and depend on
        // items that node's author owns; its wrapper items, a link around
        // the node, are stepped over as any other: the content shares the
        // link and goes with it)
      } else {
        break;
      }
      this.forward();
    }
  }

  /**
   * Whether every key of the family of `item` has, after the items of its
   * unit from `item` on, the value `formats` gives it (null where it gives
   * none).
   */
  private unitGives(item: Item, formats: Record<string, unknown>): boolean {
    const after = new Map<string, unknown>();
    for (const it of unitFrom(item)) {
      after.set(keyOf(it), valueOf(it));
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
   * The keys content with `formats` writes items of its own for even where
   * the cursor already has their values: a tab's type, where the cursor is
   * inside another segment's run (a node Lexical keeps apart from an equal
   * neighbour, see SEGMENT_KEY) whose own write opened that type, and the
   * content starts a segment of its own. Why: that run is its author's,
   * opened and closed by the items of one write; a tab inside it that writes
   * only its segment key reads its type from that write, and the author's
   * undo deletes it (a tab written right after another client's tab, which
   * that client undid, read as a "\t" in the text before it). Nothing else
   * is owned: a format or link of the text around would come back where a
   * peer removed it at the same time, and other types and modes follow the
   * runs they are written in, where a concurrent change of the line (a code
   * line made a paragraph, which makes its highlighter's tokens plain text)
   * must reach them. Null when there are none.
   */
  private ownSegmentKeys(formats: Record<string, unknown>): Set<string> | null {
    const segment = formats[SEGMENT_KEY] ?? null;
    const current = this.formats.get(SEGMENT_KEY) ?? null;
    if (
      segment === null ||
      current === null ||
      equalFormatValue(current, segment)
    ) {
      return null;
    }
    const opener = this.valueSource(SEGMENT_KEY);
    // A run this client wrote needs none: its own undo removes its later
    // write first.
    if (opener === null || opener.id.client === this.tr.doc.clientID) {
      return null;
    }
    if (
      decodeFormatValue(formats[TYPE_KEY] ?? null) !== 'tab' ||
      !equalFormatValue(this.formats.get(TYPE_KEY) ?? null, formats[TYPE_KEY])
    ) {
      return null;
    }
    const source = this.valueSource(TYPE_KEY);
    return source !== null && this.oneWrite(opener, source)
      ? new Set([TYPE_KEY])
      : null;
  }

  /**
   * The live format item that gives `key` its value at the cursor: the last
   * one the cursor passed, or the nearest one before where it started.
   */
  private valueSource(key: string): Item | null {
    const passed = this.sources.get(key);
    if (passed !== undefined) {
      return passed;
    }
    let steps = 0;
    for (let it = this.left; it !== null && steps < 4096; it = it.left) {
      steps++;
      if (
        isFormat(it) &&
        !isGone(it) &&
        !this.isHeldFormat(it) &&
        keyOf(it) === key
      ) {
        return it;
      }
    }
    return null;
  }

  /**
   * Whether format items `a` and `b` are of one write: one client wrote
   * them with only format items between them.
   */
  private oneWrite(a: Item, b: Item): boolean {
    if (a === b) {
      return true;
    }
    if (a.id.client !== b.id.client) {
      return false;
    }
    // Every item between them is one of that client's format items: the
    // walk stops at the first other item, so it costs at most the items
    // of one write (a write may open many keys, a comment's ids each one).
    const [first, last] = a.id.clock < b.id.clock ? [a, b] : [b, a];
    const store = this.tr.doc.store;
    for (let clock = first.id.clock + first.length; clock < last.id.clock; ) {
      const struct = store.getItem(createID(first.id.client, clock));
      if (
        !(struct instanceof Item) ||
        !(struct.content instanceof ContentFormat)
      ) {
        return false;
      }
      clock = struct.id.clock + struct.length;
    }
    return true;
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
        this.right = this.newItem(new ContentFormat(key, val as object));
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
    // The keys whose run, which this write opens, ends at another client's
    // change end it reuses (see format, rule 5).
    const reusedEnds: string[] = [];
    while (this.right !== null) {
      const r = this.right;
      if (!isGone(r) && !this.isHeldFormat(r)) {
        if (
          !isFormat(r) ||
          !equalFormatValue(negated.get(keyOf(r)), valueOf(r))
        ) {
          break;
        }
        const unit = unitFrom(r);
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
        if (
          valueOf(r) === null &&
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
      const end = val === null ? null : this.restatedEnd(key, val);
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
        (!it.deleted || this.tr.deleteSet.hasId(it.id))
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
        it.deleted ||
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
    item.integrate(this.tr, 0);
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
  ): Item {
    const f: Record<string, unknown> = {...formats};
    // A tab's node type key (`t`, with its segment key `k`) applies to tab
    // characters only (see Reader's tabRuns): text inserted under an opener
    // another write left open neither closes nor reopens it, and a line
    // marker inserted under it closes it for good, so it ends with the line.
    const openTab =
      !(TYPE_KEY in formats) &&
      decodeFormatValue(this.formats.get(TYPE_KEY) ?? null) === 'tab';
    const plainText =
      openTab &&
      content instanceof ContentString &&
      !content.str.includes('\t');
    const marker =
      openTab && content instanceof ContentType && content.type.name === MARKER;
    this.formats.forEach((_v, key) => {
      if (
        !(key in f) &&
        !(plainText && (key === TYPE_KEY || key === SEGMENT_KEY))
      ) {
        f[key] = null;
      }
    });
    this.minimizeFormatChanges(f);
    const negated = this.insertFormats(f, this.ownSegmentKeys(f));
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
   * Insert content with the formats current at the cursor (no format items).
   */
  insertPlain(content: ContentString | ContentType): Item {
    const item = this.newItem(content);
    this.right = item;
    this.forward();
    return item;
  }

  /**
   * Delete `n` content units, and collapse the format items of the run of
   * items without live content that the delete leaves (see collapseGap).
   */
  delete(n: number): void {
    let first: Item | null = null;
    let last: Item | null = null;
    while (n > 0 && this.right !== null) {
      const item = this.right;
      if (this.counts(item)) {
        if (n < item.length) {
          this.split(item, n);
        }
        n -= item.length;
        deleteItem(item, this.tr);
        first = first ?? item;
        last = item;
      }
      this.forward();
    }
    if (first !== null && last !== null) {
      this.collapseGap(first, last);
    }
  }

  /**
   * Collapse the format items of the run of items without live content (deleted
   * content and format items) that a delete of the content from `first` to
   * `last` leaves the cursor in. Per family (see formatFamily), keep the units
   * (see unitFrom) this delete leaves: those inside the content it deletes, the
   * last before it and the first after it; and of the others, which earlier
   * deletes left, the first that changes the family's value the content before
   * the run has, and the last two. Where a unit is kept, also keep, of each key
   * of its family, the last item before the end of that place (a deleted item
   * or content ends it) where without it the key would have another value
   * there: a format change keeps the item before its opener at a place (see
   * format), and with several keys a whole value's item there gives every key
   * its value. Delete the items of the rest, except, of each key, the last item
   * where without it the key would have another value after the run, and,
   * where the key's last item is kept, the last item before it of that key with
   * the same value (no other value between them) that another client wrote.
   * Invariant:
   * such a run holds, besides the units of the last delete in it, at most five
   * units per family, the items that give a family its value at the end of the
   * places of those, and items that change a key's value between the content
   * before the run and the content after it, whatever was written and deleted
   * there before. Why: a delete that leaves the format items of the content it
   * deletes live grows the items a document stores with its editing history
   * (each word of another format, comment or NodeState value typed at one place
   * and deleted again left two more: 2,000 words left 4,000; with a set stored
   * one key per member, each new comment a key of its own). And why those: a
   * concurrent writer that has not seen the delete relies on them. The units of
   * the content a delete removes give text a peer types inside it, which writes
   * no item where its value matches, its value (a line deleted while a peer
   * typed plain text after an italic word in it made that text italic, when the
   * word's closer went); the first unit ends the value of the content before
   * the run (a peer's text typed after that content without it, or a peer's
   * format change that ends its range there); the units around the deleted
   * content give text a peer typed at either of its edges, with its value or
   * without it, that value or the one after it; the last unit gives the content
   * after the run its value (two peers deleting the characters before a space
   * at once each left the space's own item, which the other relied on); and the
   * one before it gives that content the value it falls back to where a
   * concurrent format change of it removes its item (a comment resolved on a
   * character took the comment of the text deleted before it). The other
   * client's item with the key's last value stays as each client's undo deletes
   * its own items only: a run's end and the null another client wrote right
   * after it (see format, rule 5) each end the run where the other's writer
   * removes theirs (a paste over plain text typed after a word two comments
   * cover kept only the typist's null of one comment, and the typist's
   * concurrent undo left that comment on to the end of the document). The
   * items a kept
   * unit's place holds for the other keys of its family give content restored
   * there, as an undo of its delete restores it, the value it had: a word two
   * clients gave a comment each, deleted, kept one comment's opener once a
   * peer's later delete next to it collapsed the run, so the undo brought it
   * back with one comment (each client's own writes are undone last first, so
   * its own later delete is undone before its earlier one). Yjs' deleteText
   * keeps the last item only, and not even that one where it repeats the value
   * before the run (its cleanupFormattingGap), which lost the value in each of
   * those cases. What the bound gives up: text a peer types inside content an
   * earlier delete in the run removed, once a later delete collapsed it, takes
   * the value that content had at its start where its value changed more than
   * once along it, and text typed at the edges of such content can take the
   * value of content deleted later; content an undo restores there, of a delete
   * a peer's later delete collapsed the run of, can take those values too.
   */
  private collapseGap(first: Item, last: Item): void {
    const start =
      this.gapStart === null ? this.parent._start : this.gapStart.right;
    const byFamily = new Map<string, Item[][]>();
    // The format items left of the cursor (their values are in formats).
    const passed = new Set<Item>();
    // Per family, the units this delete leaves: those inside the deleted
    // content, the last before it and the first after it.
    const around = new Set<Item[]>();
    const lastBefore = new Map<string, Item[]>();
    const firstAfter = new Set<string>();
    let leftOfCursor = true;
    let phase = 0;
    let prev: Item | null = null;
    let prevUnit: Item[] | null = null;
    // The place of each unit: a deleted item or content ends a place.
    const placeOf = new Map<Item[], number>();
    let place = 0;
    for (let it = start; it !== null && !isLiveContent(it); it = it.right) {
      if (it === this.right) {
        leftOfCursor = false;
      }
      if (this.isHeldFormat(it)) {
        continue;
      }
      if (it === first) {
        phase = 1;
        for (const kept of lastBefore.values()) {
          around.add(kept);
        }
      }
      let unit: Item[] | null = null;
      if (isGone(it) || !isFormat(it)) {
        place++;
      } else {
        const family = formatFamily(keyOf(it));
        if (
          prev !== null &&
          prevUnit !== null &&
          continuesUnit(prevUnit, prev, it)
        ) {
          unit = prevUnit;
          unit.push(it);
        } else {
          unit = [it];
          placeOf.set(unit, place);
          const units = byFamily.get(family);
          if (units === undefined) {
            byFamily.set(family, [unit]);
          } else {
            units.push(unit);
          }
        }
        if (leftOfCursor) {
          passed.add(it);
        }
        if (phase === 0) {
          lastBefore.set(family, unit);
        } else if (phase === 1) {
          around.add(unit);
        } else if (!firstAfter.has(family)) {
          firstAfter.add(family);
          around.add(unit);
        }
      }
      prev = it;
      prevUnit = unit;
      if (it === last) {
        phase = 2;
      }
    }
    const atStart = (key: string): unknown =>
      this.gapFormats.has(key)
        ? (this.gapFormats.get(key) ?? null)
        : (this.formats.get(key) ?? null);
    for (const units of byFamily.values()) {
      if (units.length < 3) {
        continue;
      }
      const keep = new Set<Item>();
      const keepUnit = (unit: Item[] | undefined) => {
        for (const it of unit ?? []) {
          keep.add(it);
        }
      };
      keepUnit(
        units.find(unit =>
          unit.some(it => !equalFormatValue(valueOf(it), atStart(keyOf(it)))),
        ),
      );
      for (const unit of units) {
        if (around.has(unit)) {
          keepUnit(unit);
        }
      }
      keepUnit(units[units.length - 2]);
      keepUnit(units[units.length - 1]);
      // Where a unit is kept, the value its family's keys have at the end of
      // that place stays (a format change keeps the item before its opener
      // there, and with several keys a whole value's item there gives every
      // key its value): those keys' last items before that end are kept too.
      {
        const lastAt = new Map<string, Item>();
        const keptValue = new Map<string, unknown>();
        for (let i = 0; i < units.length; ) {
          let kept = false;
          let j = i;
          for (
            ;
            j < units.length && placeOf.get(units[j]) === placeOf.get(units[i]);
            j++
          ) {
            for (const it of units[j]) {
              lastAt.set(keyOf(it), it);
              if (keep.has(it)) {
                kept = true;
                keptValue.set(keyOf(it), valueOf(it));
              }
            }
          }
          if (kept) {
            for (const [key, it] of lastAt) {
              const value = keptValue.has(key)
                ? keptValue.get(key)
                : atStart(key);
              if (!equalFormatValue(value, valueOf(it))) {
                keep.add(it);
                keptValue.set(key, valueOf(it));
              }
            }
          }
          i = j;
        }
      }
      // The value of each key after the run stays; where the key's last item
      // stays, so does the last item before it with the same value that
      // another client wrote.
      const lastOf = new Map<string, Item>();
      const lastKept = new Map<string, Item>();
      const otherClient = new Map<string, Item>();
      for (const unit of units) {
        for (const it of unit) {
          const key = keyOf(it);
          const before = lastOf.get(key);
          if (before !== undefined) {
            if (!equalFormatValue(valueOf(before), valueOf(it))) {
              otherClient.delete(key);
            } else if (before.id.client !== it.id.client) {
              otherClient.set(key, before);
            }
          }
          lastOf.set(key, it);
          if (keep.has(it)) {
            lastKept.set(key, it);
          }
        }
      }
      for (const [key, it] of lastOf) {
        const kept = lastKept.get(key);
        if (
          !equalFormatValue(
            kept === undefined ? atStart(key) : valueOf(kept),
            valueOf(it),
          )
        ) {
          keep.add(it);
        }
        const other = otherClient.get(key);
        if (keep.has(it) && other !== undefined) {
          keep.add(other);
        }
      }
      const values = new Map<string, unknown>();
      const changed = new Set<string>();
      for (const unit of units) {
        for (const it of unit) {
          if (!keep.has(it)) {
            deleteItem(it, this.tr);
            if (passed.has(it)) {
              changed.add(keyOf(it));
            }
          } else if (passed.has(it)) {
            values.set(keyOf(it), valueOf(it));
          }
        }
      }
      // The value at the cursor: the last item left of it that stays.
      for (const key of changed) {
        const value = values.has(key) ? values.get(key) : atStart(key);
        if (value === null) {
          this.formats.delete(key);
        } else {
          this.formats.set(key, value);
        }
      }
    }
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
   *    delete may drop it (it keeps a bounded number of the items it leaves,
   *    see collapseGap), and the restored value ran on to the end of the
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
        (negated.size > 0 && (isGone(this.right) || isFormat(this.right))))
    ) {
      const r = this.right;
      if (this.isHeldFormat(r)) {
        this.forward();
        continue;
      }
      if (!isGone(r)) {
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
                deleteItem(earlier, this.tr);
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
            deleteItem(r, this.tr);
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
        } else if (isLiveContent(r)) {
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
    for (
      let it = this.right;
      it !== null && !isLiveContent(it);
      it = it.right
    ) {
      if (!isGone(it) && isFormat(it) && !ahead.has(keyOf(it))) {
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
        }
      }
    }
    this.passed = null;
    this.insertNegatedFormats(negated, true);
  }
}
