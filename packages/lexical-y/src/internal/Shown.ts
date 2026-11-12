/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Hidden} from './Hidden';
import type {LexicalNode, NodeKey} from 'lexical';

import {
  ContentFormat,
  ContentType,
  type IdSet,
  type Item,
  type Node as YNode,
} from '@y/y';
import {$getNodeByKey} from 'lexical';

import {INLINE_PREFIX} from './Schema';
import {isEndItem} from './State';
import {deleted, inserted, scopedView, type View} from './Unread';

/*
 * The one filter for what a binding's editor shows of the document.
 *
 * The editor shows the stored items less three things, each with its own
 * owner and its own input:
 *
 * 1. Unread (D108; `view`, see Unread): a remote change the binding has not
 *    read yet. What it inserted is not there, what it deleted still is.
 * 2. Held (the composition hold; `hidden`, see Hidden): what a collaborator
 *    changed in the line being composed. What the change inserted is not
 *    there (by id range, so an item can be held in part, see heldRuns), and
 *    a format item it deleted still is (kept).
 * 3. Left out (D116; `leftOut`, see $isLeftOutInline): a stored inline
 *    element that holds no content, which no reader makes a node for.
 *
 * `facts` is the only place that decides them. It is private to this
 * module, with the masks that name what to look up: a mask that left out a
 * fact another depends on would answer wrongly, so no caller composes one.
 * `factsOf` is the same decision with every fact looked up, and
 * `whyNotShown` the only reading of it that names a reason. Every other
 * boolean export is a lane: the same facts, asked with some of the three
 * inputs left out, because its caller handles that part itself or reads a
 * different document. No other module asks the hold, the unread changes or
 * a left-out predicate, and none joins two lanes in one condition: a
 * question the lanes do not answer becomes a lane here. A test that reads
 * the sources with the TypeScript compiler holds both rules
 * (ShownFilter.test.ts, which also pins every lane's answer):
 *
 * | Lane             | Not there when                      | Asked by |
 * | ---------------- | ----------------------------------- | -------- |
 * | isGoneIn         | gone                                | every walk of a write's document: held content is split and counted by its caller (Cursor#counts) |
 * | isHiddenIn       | gone, or held                       | a format item or an end as the composed line shows it, in a view that carries the hold's kept items (the write's cursor, the shown fold) |
 * | isPassedIn       | gone, or a held format item         | the write's cursor, looking for format items |
 * | isShownIn        | gone and not kept, or held          | the same, for a caller whose view may not carry them (the reader) |
 * | isShownEndIn     | gone, or held, or not an end item   | every walk from unit to unit |
 * | isStoredIn       | gone, or kept                       | the stored fold: what the line hands on to the lines after it |
 * | isGoneFromLineIn | gone and not kept                   | the stored atoms of a line, which take held text out by runs |
 * | isLiveContent    | gone, or not countable              | the cursor's stops |
 * | isShownContent   | gone, not countable, or left out    | every count of positions |
 * | isLeftOutIn      | (the left-out content itself)       | a delete that meets a left-out element |
 * | isHeld           | (the held items themselves)         | the reader of a remote change, which reads Yjs as it is |
 * | isHeldFormat     | (the held format items themselves)  | the cursor, which passes over them |
 * | isHeldFormatIn   | (those of them not gone)            | a format change's cursor: a held item of its key the write's view still has ends a run it writes |
 * | isKept           | (the kept items themselves)         | the reader and the cursor, for the formats a hold shows |
 * | wasShownBefore   | held, inserted by the change being read, or deleted before it and not kept | the reader, deciding whether a deleted format item can go on showing in its line (the fourth input: the change) |
 *
 * "Gone" is Yjs's `deleted` read through the unread changes: gone where an
 * unread change inserted the item, not gone where one deleted it. A view
 * made for a binding also carries its hold's kept items (Unread#keeps), so
 * a kept item is not gone in it; isShownIn asks the hold as well, for the
 * views that do not.
 *
 * Raw `item.deleted` reads Yjs as it is: right for the reader of a remote
 * change and for scans of what each client wrote. Attributes are read and
 * written through the same view in Seen.
 */

/** Why the editor does not show an item (see whyNotShown). */
export type NotShown = 'unread' | 'deleted' | 'held' | 'left-out';

/**
 * A hold a fold reads in (see Ident.FoldIn), or null: of a hold, only what
 * it holds back.
 */
export type HeldView = {hides(item: Item): boolean} | null;

/**
 * Names a stored element the editor does not show (see $isLeftOutInline),
 * or null where none is left out.
 */
export type LeftOut = ((item: Item) => boolean) | null;

/** An unread change inserted the item (D108). */
const UNREAD = 1;
/**
 * The item is deleted, and no unread change deleted it (D108), nor does the
 * view keep it (see Unread#keeps).
 */
const DELETED = 2;
/** A deleted format item the hold keeps showing (see Hidden#keeps). */
const KEPT = 4;
/** All of the item is held back (see Hidden#hides). */
const HELD = 8;
/** A stored inline element the editor does not show (D116). */
const LEFT_OUT = 16;
/** Gone in the view (see isGoneIn). */
// A literal: a computed module-scope value (UNREAD | DELETED) pins the
// module into every bundle that imports it (see treeShakingSource.test.ts).
const GONE = 3; // UNREAD | DELETED

/**
 * What is known of `item`, of the facts `want` names: the one decision every
 * lane reads. A fact not asked for is not looked up (`leftOut` runs in an
 * editor read or update, and only over countable content that is not gone),
 * but for one: only an item that is not gone is left out, so LEFT_OUT looks
 * up GONE as well, whether or not `want` names it.
 */
function facts(
  view: View | null,
  item: Item,
  hidden: Hidden | null,
  leftOut: LeftOut,
  want: number,
): number {
  let found = 0;
  if ((want & (GONE | LEFT_OUT)) !== 0) {
    found |= goneIn(view, item);
  }
  if ((want & KEPT) !== 0 && hidden !== null && hidden.keeps(item)) {
    found |= KEPT;
  }
  if ((want & HELD) !== 0 && hidden !== null && hidden.hides(item)) {
    found |= HELD;
  }
  if (
    (want & LEFT_OUT) !== 0 &&
    leftOut !== null &&
    (found & GONE) === 0 &&
    item.countable &&
    leftOut(item)
  ) {
    found |= LEFT_OUT;
  }
  return found;
}

// The lanes below ask each fact only where their answer still depends on it
// (a gone item is not asked of the hold, a live one not of its keeps), as
// the conditions they replaced did: the hold's lookups walk its ranges.

/** Whether `hidden` holds `item` back (Hidden#hides). */
function isHeldBy(hidden: Hidden | null, item: Item): boolean {
  return hidden !== null && hidden.hides(item);
}

/** Whether `hidden` keeps showing deleted `item` (Hidden#keeps). */
function isKeptBy(hidden: Hidden | null, item: Item): boolean {
  return hidden !== null && hidden.keeps(item);
}

/** Whether countable `item` is one `leftOut` names (live items only). */
function isLeftOutBy(leftOut: LeftOut, item: Item): boolean {
  return leftOut !== null && item.countable && leftOut(item);
}

/** UNREAD, DELETED or 0: how `item` is gone in `view` (see scopedView). */
function goneIn(view: View | null, item: Item): number {
  const scoped = scopedView(view, item.parent as YNode);
  if (scoped === null) {
    return item.deleted ? DELETED : 0;
  }
  if (inserted(scoped, item)) {
    return UNREAD;
  }
  if (!item.deleted) {
    return 0;
  }
  if (scoped.removed.hasId(item.id)) {
    return DELETED;
  }
  // Deleted by an unread change, or by a held change that the line being
  // composed still shows (a format item, see Hidden#keeps).
  return !deleted(scoped, item) &&
    (scoped.keeps === null || !scoped.keeps(item))
    ? DELETED
    : 0;
}

/** Every fact the filter decides of an item (see factsOf). */
export interface ShownFacts {
  /** An unread change inserted it (D108). */
  readonly unread: boolean;
  /**
   * It is deleted, and no unread change deleted it (D108), nor does the
   * view keep it (see Unread#keeps).
   */
  readonly deleted: boolean;
  /** A deleted format item the hold keeps showing (see Hidden#keeps). */
  readonly kept: boolean;
  /** All of it is held back (see Hidden#hides). */
  readonly held: boolean;
  /** A stored inline element the editor does not show (D116). */
  readonly leftOut: boolean;
}

/**
 * Every fact of `item` (see ShownFacts), all looked up: what each lane is
 * defined on (see the test that pins them), and what a diagnostic can print.
 * In an editor read or update where `leftOut` is not null.
 */
export function factsOf(
  view: View | null,
  item: Item,
  hidden: Hidden | null,
  leftOut: LeftOut = null,
): ShownFacts {
  const found = facts(
    view,
    item,
    hidden,
    leftOut,
    GONE | KEPT | HELD | LEFT_OUT,
  );
  return {
    deleted: (found & DELETED) !== 0,
    held: (found & HELD) !== 0,
    kept: (found & KEPT) !== 0,
    leftOut: (found & LEFT_OUT) !== 0,
    unread: (found & UNREAD) !== 0,
  };
}

/**
 * Why the editor does not show `item`, or null where it shows it: the whole
 * filter, in the order the three subtractions apply. An item held in part
 * is shown (see heldRuns for the part).
 * - 'unread': an unread change inserted it (D108);
 * - 'deleted': it is deleted, by no unread change, and the hold does not
 *   keep it;
 * - 'held': the composition holds it back;
 * - 'left-out': a stored inline element holding no content (D116).
 */
export function whyNotShown(
  view: View | null,
  item: Item,
  hidden: Hidden | null,
  leftOut: LeftOut = null,
): NotShown | null {
  // Each fact looked up only where the answer still depends on it.
  const gone = goneIn(view, item);
  if (gone !== 0 && !isKeptBy(hidden, item)) {
    return gone === UNREAD ? 'unread' : 'deleted';
  }
  if (isHeldBy(hidden, item)) {
    return 'held';
  }
  return gone === 0 && isLeftOutBy(leftOut, item) ? 'left-out' : null;
}

// ---------------------------------------------------------------------------
// Lanes

/**
 * Whether `item` is gone in `view` (see scopedView): Yjs's `deleted`, with
 * what the view's unread changes inserted gone and what they deleted not.
 */
export function isGoneIn(view: View | null, item: Item): boolean {
  return facts(view, item, null, null, GONE) !== 0;
}

/** Whether all of `item` is held back (see Hidden). */
export function isHeld(item: Item, hidden: HeldView): boolean {
  // (Only what the hold holds back is asked of it.)
  return facts(null, item, hidden as Hidden | null, null, HELD) !== 0;
}

/** Whether `item` is a format item the hold holds back (see isHeld). */
export function isHeldFormat(item: Item, hidden: Hidden | null): boolean {
  return (
    hidden !== null &&
    item.content instanceof ContentFormat &&
    isHeld(item, hidden)
  );
}

/**
 * Whether `item` is a format item the hold holds back that `view` still
 * has: not gone in it (see isGoneIn, isHeldFormat).
 */
export function isHeldFormatIn(
  view: View | null,
  item: Item,
  hidden: Hidden | null,
): boolean {
  return (
    item.content instanceof ContentFormat &&
    goneIn(view, item) === 0 &&
    isHeldBy(hidden, item)
  );
}

/**
 * A change being read (a transaction): what it inserted and what it
 * deleted.
 */
export interface ChangeSets {
  readonly insertSet: IdSet;
  readonly deleteSet: IdSet;
}

/**
 * Whether `item` showed before `change`, the change being read (null:
 * none): live and neither held back nor inserted by the change, or deleted
 * by the change or kept by the hold (an item deleted before that the hold
 * does not keep shows nowhere, though an undo manager may keep it
 * findable). Yjs as it is, with no view: the reader of a remote change
 * reads the document the change made.
 */
export function wasShownBefore(
  item: Item,
  hidden: Hidden | null,
  change: ChangeSets | null,
): boolean {
  if (isHeldBy(hidden, item)) {
    return false;
  }
  if (goneIn(null, item) !== 0) {
    return (
      isKeptBy(hidden, item) ||
      (change !== null && change.deleteSet.hasId(item.id))
    );
  }
  return change === null || !change.insertSet.hasId(item.id);
}

/**
 * Whether a write's cursor passes over `item` as not there: gone in `view`,
 * or a format item the hold holds back. Held content is not passed: the
 * cursor splits it from what is shown and does not count it (see
 * Cursor#counts).
 */
export function isPassedIn(
  view: View | null,
  item: Item,
  hidden: Hidden | null,
): boolean {
  return (
    goneIn(view, item) !== 0 ||
    (item.content instanceof ContentFormat && isHeldBy(hidden, item))
  );
}

/**
 * Whether `item` is a deleted format item the hold keeps showing (see
 * Hidden#keeps).
 */
export function isKept(item: Item, hidden: Hidden | null): boolean {
  return facts(null, item, hidden, null, KEPT) !== 0;
}

/**
 * Whether `item` is gone in `view` or held back: not there in the line
 * being composed, read in a view that carries the hold's kept items.
 */
export function isHiddenIn(
  view: View | null,
  item: Item,
  hidden: HeldView,
): boolean {
  // (Only what the hold holds back is asked of it.)
  return goneIn(view, item) !== 0 || isHeldBy(hidden as Hidden | null, item);
}

/**
 * Whether `item` is gone in `view` and the hold does not keep showing it:
 * in the line being composed, not there but for what is held (see
 * heldRuns).
 */
export function isGoneFromLineIn(
  view: View | null,
  item: Item,
  hidden: Hidden | null,
): boolean {
  return goneIn(view, item) !== 0 && !isKeptBy(hidden, item);
}

/**
 * Whether the editor shows `item`: live in `view` (or a deleted item
 * `hidden` keeps showing) and not held back.
 */
export function isShownIn(
  view: View | null,
  item: Item,
  hidden: Hidden | null,
): boolean {
  return whyNotShown(view, item, hidden) === null;
}

/**
 * Whether `it` ends a unit as the editor shows its container: an end item
 * live in `view` that is not held back (see Hidden).
 */
export function isShownEndIn(
  view: View | null,
  it: Item,
  hidden: Hidden | null,
): boolean {
  // The cheap type test first: walks over a line's items (most of them text
  // and format items) then look up the view only for its ends.
  return isEndItem(it) && !isHiddenIn(view, it, hidden);
}

/**
 * Whether `item` is in the document as stored: not gone in `view`, and not
 * a deleted item a hold keeps showing (see Hidden#keeps).
 */
export function isStoredIn(
  view: View | null,
  item: Item,
  hidden: Hidden | null,
): boolean {
  // (A live item is not asked of the hold's keeps, which hold only deleted
  // items.)
  return goneIn(view, item) === 0 && !(item.deleted && isKeptBy(hidden, item));
}

/**
 * Which items a start formats map was folded over, so that a refold keeps
 * it (see Seen.frontierOf):
 * - 'raw': every item not deleted (the reader's folds, and main's);
 * - 'stored': the document the write sees as it is stored (see isStoredIn): a
 *   held insertion counts, a deleted item a hold keeps showing does not;
 * - 'shown': what the write's view shows (see isGoneIn), with what `hidden`
 *   holds back left out and its held ends pairing nothing (see
 *   Reader#held): the display of the line being composed.
 */
export type FoldLane = 'raw' | 'stored' | 'shown';

/**
 * Whether format item `it` counts in a fold of lane `lane` (see FoldLane).
 */
export function inLane(
  view: View | null,
  it: Item,
  lane: FoldLane,
  hidden: Hidden | null,
): boolean {
  return lane === 'raw'
    ? !it.deleted
    : lane === 'stored'
      ? isStoredIn(view, it, hidden)
      : !isHiddenIn(view, it, hidden);
}

/** A live countable item: text, a child node, an embed. */
export function isLiveContent(view: View | null, item: Item): boolean {
  return !isGoneIn(view, item) && item.countable;
}

/**
 * Whether `item` is content the editor shows: live content (see
 * isLiveContent) that `leftOut` does not name. The one rule the writer counts
 * positions by: the cursor's moves and deletes, a removed line's delete (see
 * countShown), the stored atoms a format pass compares
 * (readAtomsLimited), and whether an element holds content
 * (hasLiveContent).
 */
export function isShownContent(
  view: View | null,
  item: Item,
  leftOut: LeftOut,
): boolean {
  return (
    item.countable && facts(view, item, null, leftOut, GONE | LEFT_OUT) === 0
  );
}

/**
 * Whether `item` is live content `leftOut` names: a stored element the
 * editor does not show (see $isLeftOutInline).
 */
export function isLeftOutIn(
  view: View | null,
  item: Item,
  leftOut: LeftOut,
): boolean {
  return (facts(view, item, null, leftOut, GONE | LEFT_OUT) & LEFT_OUT) !== 0;
}

// ---------------------------------------------------------------------------
// Lengths and parts: an item can be held in part

/**
 * The runs of `item` (offsets within it), alternating held and shown:
 * `[length, held]` pairs that add up to the item's length (see
 * Hidden#runs).
 */
export function heldRuns(item: Item, hidden: Hidden): [number, boolean][] {
  return hidden.runs(item);
}

/** Whether any part of `item` is held back (see Hidden#overlaps). */
export function isHeldInPart(item: Item, hidden: Hidden | null): boolean {
  return hidden !== null && hidden.overlaps(item);
}

/**
 * The units of `item` that are not held back, whether or not it is live
 * (see shownLengthIn for the length the editor shows).
 */
export function unheldLength(item: Item, hidden: Hidden | null): number {
  return hidden === null ? item.length : hidden.shownLength(item);
}

/**
 * The length of `item` the editor shows, which every position counts by:
 * none where it is not content the editor shows (see isShownContent: not
 * countable, gone in `view`, or left out), else the units `hidden` does not
 * hold back.
 */
export function shownLengthIn(
  view: View | null,
  item: Item,
  hidden: Hidden | null,
  leftOut: LeftOut = null,
): number {
  if (!isShownContent(view, item, leftOut)) {
    return 0;
  }
  return unheldLength(item, hidden);
}

/**
 * The units the editor shows of the items from `start` up to `stop`
 * (exclusive; see shownLengthIn): what the writer's cursor counts between
 * them (see Cursor#delete for when it deletes an element left out).
 */
export function countShown(
  view: View | null,
  start: Item | null,
  stop: Item | null,
  hidden: Hidden | null = null,
  leftOut: LeftOut = null,
): number {
  let n = 0;
  for (let it = start; it !== null && it !== stop; it = it.right) {
    n += shownLengthIn(view, it, hidden, leftOut);
  }
  return n;
}

/**
 * The end item before `it` in its container that the editor shows (see
 * isShownEndIn), or null.
 */
export function prevShownEnd(
  view: View | null,
  it: Item | null,
  hidden: Hidden | null,
): Item | null {
  for (let p = it === null ? null : it.left; p !== null; p = p.left) {
    if (isShownEndIn(view, p, hidden)) {
      return p;
    }
  }
  return null;
}

/** The part of string item `item`'s text `str` the editor shows. */
export function shownText(str: string, item: Item, hidden: Hidden): string {
  const runs = heldRuns(item, hidden);
  if (runs.length === 1) {
    return runs[0][1] ? '' : str;
  }
  let out = '';
  let pos = 0;
  for (const [len, isHidden] of runs) {
    if (!isHidden) {
      out += str.slice(pos, pos + len);
    }
    pos += len;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Left-out inline elements (D116)

/**
 * Whether shared node `y` holds content that is not deleted, in `view` (see
 * isGoneIn: in the document a write sees, content a change not read yet
 * inserted does not count), less the items `leftOut` names (a nested
 * element the editor does not show either, see $isLeftOutInline).
 */
export function hasLiveContent(
  view: View | null,
  y: YNode,
  leftOut: LeftOut = null,
): boolean {
  for (let it = y._start; it !== null; it = it.right) {
    if (isShownContent(view, it, leftOut)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether live item `it` is a stored inline element the editor does not show:
 * one holding no content (an element left out itself is none) that the
 * editor did not hold before this update either (readers leave out an
 * element that cannot be empty, as Lexical would remove it: a mark whose
 * text peers deleted concurrently, or whose text has not arrived yet, see
 * Reader). An empty element the editor shows
 * (its class or the instance allows it), and one the update removed, count.
 * The writer does not count one it leaves out, and deletes it only where a
 * delete meets it before its last unit (see Cursor#delete) or past the end of
 * content it ends (see Cursor#deleteLeftOutBefore). In an editor read
 * or update; `view`: the document the write sees; `prevMap`: the node map
 * before the update; `made`: items the write itself inserted, never left
 * out. The one predicate for the rule: the writer (Writer#leftOut), its
 * cursor, a delete's size and the self-check all read through it.
 */
export function $isLeftOutInline(
  view: View | null,
  it: Item,
  keyByY: WeakMap<YNode, NodeKey>,
  prevMap: ReadonlyMap<NodeKey, LexicalNode>,
  made: ((item: Item) => boolean) | null = null,
): boolean {
  const content = it.content;
  if (
    isGoneIn(view, it) ||
    !(content instanceof ContentType) ||
    (made !== null && made(it))
  ) {
    return false;
  }
  const y = content.type as YNode;
  const name = typeof y.name === 'string' ? y.name : '';
  // Content counts unless it is an element left out itself (a comment
  // inside a comment, both emptied): readers show neither.
  if (
    !name.startsWith(INLINE_PREFIX) ||
    hasLiveContent(view, y, child =>
      $isLeftOutInline(view, child, keyByY, prevMap, made),
    )
  ) {
    return false;
  }
  // The node a read made for it (see Reader); a shared node no read mapped
  // counts.
  const key = keyByY.get(y);
  if (key === undefined) {
    return false;
  }
  const node = $getNodeByKey(key);
  return (node === null || !node.isAttached()) && !attachedIn(prevMap, key);
}

/** Whether node `key` of `map` is attached to the root there. */
function attachedIn(
  map: ReadonlyMap<NodeKey, LexicalNode>,
  key: NodeKey,
): boolean {
  for (let k: NodeKey | null = key; k !== null; ) {
    if (k === 'root') {
      return true;
    }
    const n = map.get(k);
    if (n === undefined) {
      return false;
    }
    k = n.__parent ?? (n as {__slotHost?: null | NodeKey}).__slotHost ?? null;
  }
  return false;
}
