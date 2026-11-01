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
  ContentType,
  createID,
  createIdSet,
  type IdSet,
  Item,
  Node as YNode,
  type Transaction,
} from '@y/y';

import {isEndItem, typeOf} from './State';
import {deleted, inserted, type Unread, viewOf} from './Unread';

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

/** Whether `item` is deleted, in the document the write sees. */
export function isGone(item: Item): boolean {
  const view = viewOf(item.parent as YNode);
  if (view === null) {
    return item.deleted;
  }
  if (inserted(view, item)) {
    return true;
  }
  if (!item.deleted) {
    return false;
  }
  return !deleted(view, item) || view.removed.hasId(item.id);
}

/** What each write only noted as deleted (see deleteItem), by transaction. */
const notedIn = new WeakMap<Transaction, IdSet>();

/**
 * Delete `item` (not gone, see isGone): an item an unread change deleted is
 * only noted as deleted by this write.
 */
export function deleteItem(item: Item, tr: Transaction): void {
  if (item.deleted) {
    const view = viewOf(item.parent as YNode);
    if (view !== null) {
      view.removed.add(item.id.client, item.id.clock, item.length);
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
  const view = viewOf(y);
  if (view === null) {
    return y.getAttr(key);
  }
  const v = attrItem(y, view, key);
  if (v === null || isGone(v)) {
    return undefined;
  }
  const content = v.content.getContent();
  return content[content.length - 1];
}

/** The attributes of `y`, in the document the write sees. */
export function attrsOf(y: YNode): Record<string, unknown> {
  if (viewOf(y) === null) {
    return y.getAttrs() as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  y._map.forEach((_item, key) => {
    const value = attrOf(y, key);
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
  const view = viewOf(y);
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
      (!isGone(v) ||
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
  const view = viewOf(y);
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
  const view = viewOf(y);
  if (view === null) {
    y.deleteAttr(key);
    return;
  }
  const v = attrItem(y, view, key);
  if (v !== null && !isGone(v)) {
    deleteItem(v, tr);
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
  if (isGone(item) || !item.countable) {
    return 0;
  }
  return unheldLength(item, hidden);
}

/** Whether the editor shows `item`: live, and not held back. */
export function isShown(item: Item, hidden: Hidden | null): boolean {
  return !isGone(item) && !isHeld(item, hidden);
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
  return !isGone(it) && isEndItem(it) && !isHeld(it, hidden);
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
 * The end item before `it` in its container that the editor shows (see
 * isShownEnd), or null.
 */
export function prevLiveEnd(
  it: Item | null,
  hidden: Hidden | null,
): Item | null {
  for (let p = it === null ? null : it.left; p !== null; p = p.left) {
    if (isShownEnd(p, hidden)) {
      return p;
    }
  }
  return null;
}
