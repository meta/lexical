/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Hidden} from './Hidden';
import type {Attrs} from './Schema';

import {
  ContentAny,
  ContentBinary,
  ContentFormat,
  ContentType,
  createID,
  createIdSet,
  type Doc,
  type IdSet,
  Item,
  Node as YNode,
  type Transaction,
} from '@y/y';

import {ambientFold, pairedReadingIn, stepFormat} from './Ident';
import {EMPTY_FORMATS, isEndItem, typeOf} from './State';
import {
  currentView,
  deleted,
  inserted,
  scopedView,
  type Unread,
  type View,
} from './Unread';

/*
 * What a binding's editor shows of the document, in one place: Yjs minus
 * two things.
 *
 * - The changes the binding has not read yet (see Unread): from the moment
 *   Yjs starts applying one until the binding reads it, the binding's work
 *   (its writes, and the selection it takes) sees what they inserted as not
 *   there, what they deleted as still there, and each attribute as it was
 *   before. isGone, attrOf, attrsOf and attrsBefore read through them;
 *   setAttr, deleteAttr and deleteItem write through them. Where no view
 *   applies to an item's type (see viewOf), they are Yjs's own `deleted`,
 *   getAttr and getAttrs.
 * - The items held back while the local editor composes (see Hidden):
 *   isHeld and unheldLength.
 *
 * isShown, isShownEnd, shownLength and prevLiveEnd combine the two;
 * shownText and shownAttrs apply only the hold, to the text and attributes
 * Yjs stores now. Raw `item.deleted` and `getAttr(s)` read Yjs as it is:
 * right for the reader of remote changes and for scans of what each client
 * wrote.
 */

/** Whether all of `item` is held back (see Hidden). */
export function isHeld(item: Item, hidden: Hidden | null): boolean {
  return hidden !== null && hidden.hides(item);
}

/**
 * Whether `item` is in the document the write sees as it is stored: not
 * gone, and not a deleted item the hold only shows (see Hidden#keeps). What
 * a line hands on to the lines after it is folded from these: a held
 * insertion included, a kept deletion not.
 */
export function isStored(item: Item, hidden: Hidden | null): boolean {
  return isStoredIn(currentView(), item, hidden);
}

/** isStored, in `view`. */
export function isStoredIn(
  root: View | null,
  item: Item,
  hidden: Hidden | null,
): boolean {
  return (
    !isGoneIn(root, item) &&
    !(item.deleted && hidden !== null && hidden.keeps(item))
  );
}

/** Whether `item` is deleted, in the document the write sees. */
export function isGone(item: Item): boolean {
  return isGoneIn(currentView(), item);
}

/** isGone, in `view` (see viewFor). */
export function isGoneIn(root: View | null, item: Item): boolean {
  const view = scopedView(root, item.parent as YNode);
  if (view === null) {
    return item.deleted;
  }
  if (inserted(view, item)) {
    return true;
  }
  if (!item.deleted) {
    return false;
  }
  if (view.removed.hasId(item.id)) {
    return true;
  }
  // Deleted by an unread change, or by a held change that the line being
  // composed still shows (a format item, see Hidden#keeps).
  return !deleted(view, item) && (view.keeps === null || !view.keeps(item));
}

/** What each write only noted as deleted (see deleteItem), by transaction. */
const notedIn = new WeakMap<Transaction, IdSet>();

/**
 * Whether transaction `tr` deleted `item`, or noted it as deleted (an item
 * an unread change deleted, see deleteItem).
 */
export function deletedBy(item: Item, tr: Transaction): boolean {
  if (tr.deleteSet.hasId(item.id)) {
    return true;
  }
  const noted = notedIn.get(tr);
  return noted !== undefined && noted.hasId(item.id);
}

/**
 * Delete `item` (not gone, see isGone): an item an unread change deleted is
 * only noted as deleted by this write.
 */
/** Bumped by every deleteItem (a fold reused only while nothing was deleted). */
export let deletions = 0;
export function deleteItem(item: Item, tr: Transaction): void {
  deleteItemIn(currentView(), item, tr);
}

/** deleteItem, in `view`. */
export function deleteItemIn(
  root: View | null,
  item: Item,
  tr: Transaction,
): void {
  const view = scopedView(root, item.parent as YNode);
  deletions++;
  if (item.deleted) {
    if (view !== null) {
      view.removed.add(item.id.client, item.id.clock, item.length);
      // A format item a hold showed, deleted by this write too: the editor
      // no longer shows it (see Hidden#drop).
      if (view.dropKept !== null) {
        view.dropKept(item);
      }
      let noted = notedIn.get(tr);
      if (noted === undefined) {
        noted = createIdSet();
        notedIn.set(tr, noted);
      }
      noted.add(item.id.client, item.id.clock, item.length);
      return;
    }
  }
  item.delete(tr);
}

/**
 * The item holding attribute `key` of `y` before the unread changes (the
 * current one, or one they replaced), or null.
 */
function attrItem(y: YNode, view: Unread, key: string): Item | null {
  let v: Item | null = y._map.get(key) ?? null;
  while (v !== null && inserted(view, v)) {
    v = v.left;
  }
  return v;
}

/** The value of attribute `key` of `y`, in the document the write sees. */
export function attrOf(y: YNode, key: string): unknown {
  return attrOfIn(currentView(), y, key);
}

/** attrOf, in `view`. */
export function attrOfIn(root: View | null, y: YNode, key: string): unknown {
  const view = scopedView(root, y);
  if (view === null) {
    return y.getAttr(key);
  }
  const v = attrItem(y, view, key);
  if (v === null || isGoneIn(root, v)) {
    return undefined;
  }
  const content = v.content.getContent();
  return content[content.length - 1];
}

/** The attributes of `y`, in the document the write sees. */
export function attrsOf(y: YNode): Record<string, unknown> {
  return attrsOfIn(currentView(), y);
}

/** attrsOf, in `view`. */
export function attrsOfIn(
  root: View | null,
  y: YNode,
): Record<string, unknown> {
  if (scopedView(root, y) === null) {
    return y.getAttrs() as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  y._map.forEach((_item, key) => {
    const value = attrOfIn(root, y, key);
    if (value !== undefined) {
      out[key] = value;
    }
  });
  return out;
}

/**
 * The attributes `y` had before transaction `tr`, in the document the write
 * sees: of each name, the value of its latest item that neither `tr` nor an
 * unread change inserted, unless that item was gone before `tr`. Yjs keeps
 * the content of the items `tr` deletes until `tr` ends, so this also reads
 * a node `tr` deleted (a block it moved). With nothing unread, these are the
 * values every other client still has.
 */
export function attrsBefore(
  y: YNode,
  tr: Transaction,
): Record<string, unknown> {
  return attrsBeforeIn(currentView(), y, tr);
}

/** attrsBefore, in `view`. */
export function attrsBeforeIn(
  root: View | null,
  y: YNode,
  tr: Transaction,
): Record<string, unknown> {
  const view = scopedView(root, y);
  const out: Record<string, unknown> = {};
  y._map.forEach((latest, key) => {
    let v: Item | null = latest;
    while (
      v !== null &&
      (tr.insertSet.hasId(v.id) || (view !== null && inserted(view, v)))
    ) {
      v = v.left;
    }
    // Deleted by `tr`, or only noted as deleted by it where an unread change
    // deleted it too (see deleteItem): there before `tr`. What an earlier
    // write noted was gone before it.
    const noted = notedIn.get(tr);
    if (
      v !== null &&
      (!isGoneIn(root, v) ||
        tr.deleteSet.hasId(v.id) ||
        (noted !== undefined && noted.hasId(v.id)))
    ) {
      const content = v.content.getContent();
      out[key] = content[content.length - 1];
    }
  });
  return out;
}

/** Set attribute `key` of `y`, after its value in the document seen. */
export function setAttr(
  y: YNode,
  key: string,
  value: unknown,
  tr: Transaction,
): void {
  setAttrIn(currentView(), y, key, value, tr);
}

/** setAttr, in `view`. */
export function setAttrIn(
  root: View | null,
  y: YNode,
  key: string,
  value: unknown,
  tr: Transaction,
): void {
  const view = scopedView(root, y);
  const left = view === null ? null : attrItem(y, view, key);
  if (view === null || left === (y._map.get(key) ?? null)) {
    y.setAttr(key, value as never);
    return;
  }
  // As Y.Node#setAttr, after the value the write sees.
  const doc = tr.doc;
  const content =
    value instanceof YNode
      ? new ContentType(value)
      : value instanceof Uint8Array
        ? new ContentBinary(value)
        : new ContentAny([value]);
  new Item(
    createID(doc.clientID, doc.store.getClock(doc.clientID)),
    left,
    left && left.lastId,
    null,
    null,
    y,
    key,
    content,
  ).integrate(tr, 0);
}

/** Delete attribute `key` of `y`: its value in the document seen. */
export function deleteAttr(y: YNode, key: string, tr: Transaction): void {
  deleteAttrIn(currentView(), y, key, tr);
}

/** deleteAttr, in `view`. */
export function deleteAttrIn(
  root: View | null,
  y: YNode,
  key: string,
  tr: Transaction,
): void {
  const view = scopedView(root, y);
  if (view === null) {
    y.deleteAttr(key);
    return;
  }
  const v = attrItem(y, view, key);
  if (v !== null && !isGoneIn(root, v)) {
    deleteItemIn(root, v, tr);
  }
}

/**
 * The units of `item` that are not held back, whether or not it is live
 * (see shownLength for the length the editor shows).
 */
export function unheldLength(item: Item, hidden: Hidden | null): number {
  return hidden === null ? item.length : hidden.shownLength(item);
}

/** The length of an item the editor shows (live content only). */
export function shownLength(item: Item, hidden: Hidden | null): number {
  return shownLengthIn(currentView(), item, hidden);
}

/** shownLength, in `view`. */
export function shownLengthIn(
  root: View | null,
  item: Item,
  hidden: Hidden | null,
): number {
  if (!item.countable || isGoneIn(root, item)) {
    return 0;
  }
  return unheldLength(item, hidden);
}

/**
 * Whether the editor shows `item`: live (or a deleted format item a hold
 * keeps, see Hidden#keeps), and not held back.
 */
export function isShown(item: Item, hidden: Hidden | null): boolean {
  return isShownIn(currentView(), item, hidden);
}

/** isShown, in `view`. */
export function isShownIn(
  root: View | null,
  item: Item,
  hidden: Hidden | null,
): boolean {
  return (
    (!isGoneIn(root, item) || (hidden !== null && hidden.keeps(item))) &&
    !isHeld(item, hidden)
  );
}

/** The part of string item `item`'s text `str` the editor shows. */
export function shownText(str: string, item: Item, hidden: Hidden): string {
  const runs = hidden.runs(item);
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

/**
 * Whether `it` ends a unit as the editor shows its container: a live end
 * item that is not held back (see Hidden).
 */
export function isShownEnd(it: Item, hidden: Hidden | null): boolean {
  // The cheap type test first: walks over a line's items (most of them text
  // and format items) then look up the write's view only for its ends.
  return isEndItem(it) && !isGone(it) && !isHeld(it, hidden);
}

/** isShownEnd, in `view`. */
export function isShownEndIn(
  root: View | null,
  it: Item,
  hidden: Hidden | null,
): boolean {
  return isEndItem(it) && !isGoneIn(root, it) && !isHeld(it, hidden);
}

/**
 * Marker `end`'s attributes as the editor shows them: those a held change
 * set have the values they had (see Hidden#marker).
 */
export function shownAttrs(end: Item, hidden: Hidden | null): Attrs {
  const attrs = typeOf(end).getAttrs() as Attrs;
  const held = hidden === null ? null : hidden.marker;
  if (held !== null && held.ends.has(end)) {
    for (const [k, v] of held.was) {
      if (v === undefined) {
        delete attrs[k];
      } else {
        attrs[k] = v;
      }
    }
  }
  return attrs;
}

/**
 * Where each start formats map was folded up to (that item and everything
 * before it): every fold that makes a unit start notes it (noteFolded), and
 * a copy shares nothing (a map passed on as it is keeps it).
 */
const FOLDED = Symbol('foldedTo');
/**
 * Which items a start formats map was folded over, so that a refold keeps
 * it (see frontierOf):
 * - 'raw': every item not deleted (the reader's folds, and main's);
 * - 'stored': the document the write sees as it is stored (see isStored): a
 *   held insertion counts, a deleted item a hold keeps showing does not;
 * - 'shown': what the write's view shows (see isGone), with what `hidden`
 *   holds back left out and its held ends pairing nothing (see
 *   Ident.withHeldView): the display of the line being composed.
 */
export type FoldLane = 'raw' | 'stored' | 'shown';
type Folded = {
  [FOLDED]?: {
    to: Item | null;
    lane: FoldLane;
    /** The hold a 'stored' or 'shown' fold went by, or null. */
    hidden: Hidden | null;
    /**
     * Whether `to` lies after a walk's left, per left asked (items never
     * move, so the answer never changes). Bounded: past 8 lefts the answers
     * are dropped and asked again (each at most twice the shorter of the
     * two directed distances, see liesAfter).
     */
    after: Map<Item | null, boolean> | null;
  };
};
export function noteFolded(
  formats: object | null,
  to: Item | null,
  lane: FoldLane = 'raw',
  hidden: Hidden | null = null,
): void {
  // Never on the shared empty map: one note there would serve every unit
  // that starts with no formats (and keep the noted item's document alive).
  if (formats !== null && formats !== EMPTY_FORMATS) {
    // On the map itself (a WeakMap entry per fold cost a hash insertion per
    // fold), non-enumerable, so maps still compare and print by entries.
    const note = {after: null, hidden, lane, to};
    if (Object.prototype.hasOwnProperty.call(formats, FOLDED)) {
      (formats as Folded)[FOLDED] = note;
    } else {
      Object.defineProperty(formats, FOLDED, {value: note, writable: true});
    }
  }
}

/**
 * A copy of unit start `start` with its fold note, for another unit: a
 * start belongs to one unit, since frontierOf can fold it again in place.
 */
export function copyStart<T extends Map<string, unknown> | null>(start: T): T {
  if (start === null) {
    return start;
  }
  const copy = new Map(start);
  const note = (start as Folded)[FOLDED];
  if (note !== undefined) {
    noteFolded(copy, note.to, note.lane, note.hidden);
  }
  return copy as T;
}

/**
 * The frontier of a walk from `left` (exclusive) seeded with `start`: the
 * item `start` was folded up to, when that lies after `left` (the walk
 * would step the items up to it a second time: a paired run must not nest
 * twice), else null. Only where runs are paired: below layout 3 stepping a
 * plain value again changes nothing, and main's walks are kept byte for
 * byte.
 */
export function frontierOf(
  view: View | null,
  start: object | null,
  left: Item | null,
  parent: unknown,
): Item | null {
  if (start === null) {
    return null;
  }
  const note = (start as Folded)[FOLDED];
  if (note === undefined) {
    return null;
  }
  let to = note.to;
  if (to === null || to === left || !pairedReadingIn(parent)) {
    return null;
  }
  // By its stored id: Yjs can merge the noted item into the one before it
  // (adjacent text of one client), which leaves the noted object out of
  // the container's items; the item that holds its id now is the point.
  const doc = (parent as {doc: Doc | null}).doc;
  if (doc !== null) {
    const held = doc.store.getItem(to.id);
    if (held instanceof Item && held !== to) {
      to = held;
      note.to = held;
      note.after = null;
    }
  }
  if (to === left) {
    return null;
  }
  // A fold point that is gone is no boundary any more (a moved block's old
  // marker), and the start may be stale both ways: it holds the items that
  // were before `to` when it was folded, not those inserted since between
  // `left` and `to` (an undo restoring a word there). Where `to` lies after
  // `left`, the start is folded again from the container's start up to
  // `left` (in place: the start belongs to this unit; once, the note then
  // names `left`), and the walk steps everything from `left`.
  // (In its lane: a deleted item a hold keeps showing is no fold point of
  // a stored start, see FoldLane.)
  if (!inLane(view, to, note.lane, note.hidden)) {
    if (liesAfter(to, left, parent)) {
      refoldUpTo(
        view,
        start as Map<string, unknown>,
        left,
        parent,
        note.lane,
        note.hidden,
      );
      note.to = left;
      note.after = null;
    }
    return null;
  }
  let after = note.after === null ? undefined : note.after.get(left);
  if (after === undefined) {
    after = liesAfter(to, left, parent);
    if (note.after === null || note.after.size >= 8) {
      note.after = new Map();
    }
    note.after.set(left, after);
  }
  return after ? to : null;
}

/**
 * Whether item `to` lies after `left` (null: before the container's first
 * item) in container `parent`, exactly: a walk right from `left` and a walk
 * left from `to`, a step each in turn; the first to meet the other's end
 * answers yes, the first to leave the container answers no. At most twice
 * the shorter of the two directed distances.
 */
function liesAfter(to: Item, left: Item | null, parent: unknown): boolean {
  if (left === null) {
    return to.parent === parent;
  }
  let f: Item | null = left.right;
  let b: Item | null = to.left;
  for (;;) {
    if (f === null) {
      return false;
    }
    if (f === to) {
      return true;
    }
    f = f.right;
    if (b === null) {
      return false;
    }
    if (b === left) {
      return true;
    }
    b = b.left;
  }
}

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
      : !isGoneIn(view, it) && !isHeld(it, hidden);
}

/**
 * Fold `start` again in its lane (see FoldLane): every format item from
 * `parent`'s start to `left` the lane counts.
 */
export function refoldUpTo(
  view: View | null,
  start: Map<string, unknown>,
  left: Item | null,
  parent: unknown,
  lane: FoldLane,
  hidden: Hidden | null = null,
): void {
  start.clear();
  if (left === null) {
    return;
  }
  // The shown lane folds as the hold shows the line; the others in the
  // running work's fold (see Ident.ambientFold).
  const fold = {
    held: lane === 'shown' && hidden !== null ? hidden : ambientFold().held,
    view,
  };
  const step = (it: Item) => stepFormat(start, it, fold);
  for (
    let it: Item | null = (parent as {_start: Item | null})._start;
    it !== null;
    it = it.right
  ) {
    if (it.content instanceof ContentFormat && inLane(view, it, lane, hidden)) {
      step(it);
    }
    if (it === left) {
      break;
    }
  }
}

/**
 * Test-only: unitLeftEnd also walks as prevLiveEnd does and throws where the
 * two disagree (harnesses turn it on).
 */
let checkUnitLeft = false;
const __DEV__ = process.env.NODE_ENV !== 'production';
export function setUnitLeftChecks(on: boolean): void {
  checkUnitLeft = on;
}

/**
 * The end item before unit `unit` that the editor shows (prevLiveEnd of its
 * end), read from the unit before it in its container when that one's end
 * is shown, and null for the first unit of its container: a line's own
 * items are not walked (a line holding thousands of deleted format items
 * after toggles made every caret capture and restore walk them twice).
 * Walks where that end is not shown (held or gone).
 */
export function unitLeftEnd(
  view: View | null,
  units: readonly {end: Item | null}[],
  unit: {end: Item | null; at?: number},
  hidden: Hidden | null,
): Item | null {
  const end = unit.end!;
  // Where it was last found (a hint: units are spliced in place).
  let i = unit.at === undefined ? -1 : unit.at;
  if (units[i] !== unit) {
    i = units.indexOf(unit);
    unit.at = i;
  }
  const prev = i > 0 ? units[i - 1].end : null;
  // The first unit of its container: nothing is shown before it.
  const known = i === 0;
  const fast =
    prev !== null && isShownEndIn(view, prev, hidden) && prev !== end
      ? prev
      : null;
  if ((fast === null && !known) || (__DEV__ && checkUnitLeft)) {
    const walked = prevLiveEnd(view, end, hidden);
    if ((fast !== null || known) && walked !== fast) {
      throw new Error(
        '@lexical/y: the end before a unit is not the end of the unit before it',
      );
    }
    return walked;
  }
  return fast;
}

/**
 * The end item before `it` in its container that the editor shows (see
 * isShownEnd), or null.
 */
export function prevLiveEnd(
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
