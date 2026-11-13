/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The one filter for what a binding's editor shows of the document (see
// Shown): its answer for every class of item, pinned. A class is one way
// an item can differ between the stored document and the editor: an unread
// remote change (D108), the composition hold, a left-out inline element
// (D116). Each lane (the filter asked with some of its inputs left out) is
// pinned beside it, and checked against the facts it is defined on, so a
// lane cannot come to answer by a rule of its own.
import * as Y from '@y/y';
import {describe, expect, test} from 'vitest';

import {createYDoc} from '../..';
import {Hidden} from '../../internal/Hidden';
import {deleteItemIn} from '../../internal/Seen';
import {
  countShown,
  factsOf,
  heldRuns,
  inLane,
  isGoneFromLineIn,
  isGoneIn,
  isHeld,
  isHeldFormat,
  isHeldFormatIn,
  isHeldInPart,
  isHiddenIn,
  isKept,
  isLeftOutIn,
  isLiveContent,
  isPassedIn,
  isShownContent,
  isShownEndIn,
  isShownIn,
  isStoredIn,
  type LeftOut,
  prevShownEnd,
  shownLengthIn,
  shownText,
  wasShownBefore,
  whyNotShown,
} from '../../internal/Shown';
import {emptyView, type View} from '../../internal/Unread';
import {scanShownGuard} from '../utils/shownGuard';

interface Scene {
  doc: Y.Doc;
  /** The binding's view with its hold's kept items, as YBinding#seer makes it. */
  view: View;
  /** The same unread changes in a view that does not carry the kept items. */
  bare: View;
  hidden: Hidden;
  leftOut: LeftOut;
  /** The unread change, as the change a reader is reading. */
  change: Y.Transaction;
  /** The binding's root. */
  root: Y.Node;
  /** One item per class, by name. */
  items: Map<string, Y.Item>;
}

/** The item of `type` holding text `text` exactly, or starting with it. */
function textItem(type: Y.Node, text: string): Y.Item {
  for (let it = type._start; it !== null; it = it.right) {
    if (it.content instanceof Y.ContentString && it.content.str === text) {
      return it;
    }
  }
  throw new Error(`no item holds exactly ${JSON.stringify(text)}`);
}

/** The format items of `key` in `type`, in order. */
function formatItems(type: Y.Node, key: string): Y.Item[] {
  const out: Y.Item[] = [];
  for (let it = type._start; it !== null; it = it.right) {
    if (it.content instanceof Y.ContentFormat && it.content.key === key) {
      out.push(it);
    }
  }
  return out;
}

/** Apply to `doc` what `from` has that it lacks; returns the transaction. */
function pull(doc: Y.Doc, from: Y.Doc): Y.Transaction {
  let made: Y.Transaction | null = null;
  const note = (tr: Y.Transaction) => {
    made = tr;
  };
  doc.on('afterTransaction', note);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(from, Y.encodeStateVector(doc)));
  doc.off('afterTransaction', note);
  if (made === null) {
    throw new Error('the update changed nothing');
  }
  return made;
}

/** Hold back every item `tr` inserted in `type` (see Reader#$hold). */
function hold(hidden: Hidden, tr: Y.Transaction, type: Y.Node): void {
  for (let it = type._start; it !== null; it = it.right) {
    if (tr.insertSet.hasId(it.id)) {
      hidden.add(it.id.client, it.id.clock, it.length);
    }
  }
}

/**
 * One document holding an item of every class. `doc` is the binding's; a
 * collaborator's changes come from `peer`.
 */
function scene(gc: boolean): Scene {
  const doc = createYDoc(null, {gc});
  doc.clientID = 1;
  const root = doc.get('lexical-y');
  const peer = createYDoc(null, {gc});
  peer.clientID = 2;
  const peerRoot = peer.get('lexical-y');
  const sync = () => {
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(peer)));
  };
  const items = new Map<string, Y.Item>();

  // What the editor shows and the document stores.
  const element = new Y.Node('i:mark');
  const marker = new Y.Node('¶');
  doc.transact(() => {
    // Each before the last: adjacent text of one client, in the order of
    // its clocks, would merge into one item.
    for (const text of ['kept', 'rdel', 'udel', 'dead', 'live']) {
      root.insert(0, text);
    }
    root.insert(20, [element, marker]);
    root.format(0, 4, {'f:bold': true});
    root.format(16, 4, {'f:italic': true});
    root.format(4, 4, {'f:code': true});
  });
  sync();
  const [liveFormat] = formatItems(root, 'f:bold');
  const [keptFormat] = formatItems(root, 'f:italic');
  const [deadFormat] = formatItems(root, 'f:code');
  const dead = textItem(root, 'dead');
  doc.transact(tr => {
    dead.delete(tr);
    deadFormat.delete(tr);
  });
  sync();
  items.set('live text', textItem(root, 'live'));
  items.set('live format', liveFormat);
  items.set('live end', marker._item!);
  items.set('deleted text', dead);
  items.set('deleted format', deadFormat);
  items.set('left-out element', element._item!);

  // The composition hold: a collaborator's change the binding read and
  // holds back. It inserts text, a format and a line end, and deletes a
  // format the line shows, which the hold keeps showing.
  const hidden = new Hidden('line');
  hidden.keep(keptFormat);
  peer.transact(() => {
    peerRoot.insert(0, 'held');
    peerRoot.insert(0, [new Y.Node('¶')]);
    peerRoot.format(1, 4, {'f:held': true});
  });
  peer.transact(tr => formatItems(peerRoot, 'f:italic')[0].delete(tr));
  hold(hidden, pull(doc, peer), root);
  items.set('held text', textItem(root, 'held'));
  items.set('held format', formatItems(root, 'f:held')[0]);
  items.set(
    'held end',
    [...peerRoot.toArray()]
      .filter((v): v is Y.Node => v instanceof Y.Node)
      .map(v => doc.store.getItem(v._item!.id) as Y.Item)[0],
  );
  items.set('kept format', keptFormat);
  // Held in part: its first two units.
  peer.transact(() => peerRoot.insert(peerRoot.length, 'part'));
  pull(doc, peer);
  const part = textItem(root, 'part');
  hidden.add(part.id.client, part.id.clock, 2);
  items.set('text held in part', part);
  // Held, then deleted by its author: Yjs keeps nothing of it to show.
  // (Before the element, so that Yjs does not merge it into 'part'.)
  peer.transact(() => peerRoot.insert(peerRoot.length - 6, 'hdel'));
  hold(hidden, pull(doc, peer), root);
  const heldDeleted = textItem(root, 'hdel');
  peer.transact(tr => {
    (peer.store.getItem(heldDeleted.id) as Y.Item).delete(tr);
  });
  pull(doc, peer);
  items.set('held text, deleted', heldDeleted);

  // Unread (D108): a collaborator's change Yjs applied and the binding has
  // not read. It inserts text, a format and a line end, and deletes text
  // the editor shows.
  const view = emptyView(
    root,
    it => hidden.keeps(it),
    it => hidden.drop(it),
  );
  const udel = textItem(root, 'udel');
  const rdel = textItem(root, 'rdel');
  peer.transact(tr => {
    peerRoot.insert(peerRoot.length, 'unrd');
    peerRoot.insert(peerRoot.length, [new Y.Node('¶')]);
    peerRoot.format(peerRoot.length - 5, 4, {'f:unread': true});
    (peer.store.getItem(udel.id) as Y.Item).delete(tr);
    (peer.store.getItem(rdel.id) as Y.Item).delete(tr);
  });
  const unread = pull(doc, peer);
  view.changes.push(unread);
  items.set('unread text', textItem(root, 'unrd'));
  items.set('unread format', formatItems(root, 'f:unread')[0]);
  let unreadEnd: Y.Item | null = null;
  for (let it = root._start; it !== null; it = it.right) {
    if (unread.insertSet.hasId(it.id) && it.content instanceof Y.ContentType) {
      unreadEnd = it;
    }
  }
  items.set('unread end', unreadEnd!);
  items.set('text an unread change deleted', udel);
  // A local write deletes what an unread change deleted too.
  doc.transact(tr => deleteItemIn(view, rdel, tr));
  items.set('text an unread change and a write deleted', rdel);

  // Under another root: no view of this binding applies.
  const other = doc.get('other');
  peer.transact(() => peer.get('other').insert(0, 'else'));
  view.changes.push(pull(doc, peer));
  items.set('unread text under another root', textItem(other, 'else'));

  const bare: View = {...view, dropKept: null, keeps: null};
  const leftOut: LeftOut = it => it === element._item;
  return {bare, change: unread, doc, hidden, items, leftOut, root, view};
}

const flag = (b: boolean, name: string): string => (b ? name : '');

/** Every answer of the filter for `item`, as one line. */
function answers(s: Scene, view: View | null, item: Y.Item): string {
  const {hidden, leftOut} = s;
  return [
    `why=${whyNotShown(view, item, hidden, leftOut) ?? 'shown'}`,
    [
      flag(isGoneIn(view, item), 'gone'),
      flag(isHiddenIn(view, item, hidden), 'hidden'),
      flag(isPassedIn(view, item, hidden), 'passed'),
      flag(isGoneFromLineIn(view, item, hidden), 'goneFromLine'),
      flag(isShownIn(view, item, hidden), 'shown'),
      flag(isShownEndIn(view, item, hidden), 'shownEnd'),
      flag(isStoredIn(view, item, hidden), 'stored'),
      flag(isLiveContent(view, item), 'liveContent'),
      flag(isShownContent(view, item, leftOut), 'shownContent'),
      flag(isLeftOutIn(view, item, leftOut), 'leftOut'),
      flag(isHeld(item, hidden), 'held'),
      flag(isHeldFormat(item, hidden), 'heldFormat'),
      flag(isHeldFormatIn(view, item, hidden), 'heldFormatIn'),
      flag(isHeldInPart(item, hidden), 'heldInPart'),
      flag(isKept(item, hidden), 'kept'),
      flag(wasShownBefore(item, hidden, s.change), 'shownBefore'),
    ]
      .filter(Boolean)
      .join(','),
    `length=${shownLengthIn(view, item, hidden, leftOut)}`,
    `fold=${(['raw', 'stored', 'shown'] as const)
      .filter(lane => inLane(view, item, lane, hidden))
      .join(',')}`,
  ].join(' | ');
}

describe('the shown-items filter', () => {
  test('answers for every class, in the view a binding makes (unread changes, the hold and its kept items)', () => {
    const s = scene(false);
    const table: Record<string, string> = {};
    for (const [name, item] of s.items) {
      table[name] = answers(s, s.view, item);
    }
    expect(table).toMatchInlineSnapshot(`
      {
        "deleted format": "why=deleted | gone,hidden,passed,goneFromLine | length=0 | fold=",
        "deleted text": "why=deleted | gone,hidden,passed,goneFromLine | length=0 | fold=",
        "held end": "why=held | hidden,stored,liveContent,shownContent,held,heldInPart | length=0 | fold=raw,stored",
        "held format": "why=held | hidden,passed,stored,held,heldFormat,heldFormatIn,heldInPart | length=0 | fold=raw,stored",
        "held text": "why=held | hidden,stored,liveContent,shownContent,held,heldInPart | length=0 | fold=raw,stored",
        "held text, deleted": "why=deleted | gone,hidden,passed,goneFromLine,held,heldInPart | length=0 | fold=",
        "kept format": "why=shown | shown,kept,shownBefore | length=0 | fold=shown",
        "left-out element": "why=left-out | shown,stored,liveContent,leftOut,shownBefore | length=0 | fold=raw,stored,shown",
        "live end": "why=shown | shown,shownEnd,stored,liveContent,shownContent,shownBefore | length=1 | fold=raw,stored,shown",
        "live format": "why=shown | shown,stored,shownBefore | length=0 | fold=raw,stored,shown",
        "live text": "why=shown | shown,stored,liveContent,shownContent,shownBefore | length=4 | fold=raw,stored,shown",
        "text an unread change and a write deleted": "why=deleted | gone,hidden,passed,goneFromLine,shownBefore | length=0 | fold=",
        "text an unread change deleted": "why=shown | shown,stored,liveContent,shownContent,shownBefore | length=4 | fold=stored,shown",
        "text held in part": "why=shown | shown,stored,liveContent,shownContent,heldInPart,shownBefore | length=2 | fold=raw,stored,shown",
        "unread end": "why=unread | gone,hidden,passed,goneFromLine | length=0 | fold=raw",
        "unread format": "why=unread | gone,hidden,passed,goneFromLine | length=0 | fold=raw",
        "unread text": "why=unread | gone,hidden,passed,goneFromLine | length=0 | fold=raw",
        "unread text under another root": "why=shown | shown,stored,liveContent,shownContent,shownBefore | length=4 | fold=raw,stored,shown",
      }
    `);
    s.hidden.releaseKeeps();
  });

  test('answers that differ in a view that does not carry the kept items, and with no view', () => {
    const s = scene(false);
    const table: Record<string, string> = {};
    for (const [name, item] of s.items) {
      const inView = answers(s, s.view, item);
      const inBare = answers(s, s.bare, item);
      const inNone = answers(s, null, item);
      if (inBare !== inView) {
        table[`${name}, kept items not carried`] = inBare;
      }
      if (inNone !== inView) {
        table[`${name}, no view`] = inNone;
      }
    }
    expect(table).toMatchInlineSnapshot(`
      {
        "kept format, kept items not carried": "why=shown | gone,hidden,passed,shown,kept,shownBefore | length=0 | fold=",
        "kept format, no view": "why=shown | gone,hidden,passed,shown,kept,shownBefore | length=0 | fold=",
        "text an unread change deleted, no view": "why=deleted | gone,hidden,passed,goneFromLine,shownBefore | length=0 | fold=",
        "unread end, no view": "why=shown | shown,shownEnd,stored,liveContent,shownContent | length=1 | fold=raw,stored,shown",
        "unread format, no view": "why=shown | shown,stored | length=0 | fold=raw,stored,shown",
        "unread text, no view": "why=shown | shown,stored,liveContent,shownContent | length=4 | fold=raw,stored,shown",
      }
    `);
    s.hidden.releaseKeeps();
  });

  test('an item held in part shows the part that is not held', () => {
    const s = scene(false);
    const part = s.items.get('text held in part')!;
    expect(heldRuns(part, s.hidden)).toEqual([
      [2, true],
      [2, false],
    ]);
    expect(shownText('part', part, s.hidden)).toBe('rt');
    expect(shownLengthIn(s.view, part, s.hidden)).toBe(2);
    expect(shownLengthIn(s.view, part, null)).toBe(4);
    s.hidden.releaseKeeps();
  });

  for (const gc of [false, true]) {
    test(`every lane is its definition on the facts (gc ${gc})`, () => {
      const s = scene(gc);
      const {hidden, leftOut} = s;
      for (const view of [s.view, s.bare, null]) {
        for (const [name, item] of s.items) {
          const f = factsOf(view, item, hidden, leftOut);
          const gone = f.unread || f.deleted;
          const {held, kept, leftOut: left} = f;
          const format = item.content instanceof Y.ContentFormat;
          const label = `${name} (${view === null ? 'no view' : view === s.view ? 'view' : 'bare view'})`;
          // The facts exclude one another where the model says so.
          expect(f.unread && f.deleted, label).toBe(false);
          expect(left && gone, label).toBe(false);
          // Only a deleted format item is ever kept (see Reader#$hold).
          expect(kept && !(format && item.deleted), label).toBe(false);
          const why = whyNotShown(view, item, hidden, leftOut);
          expect(why, label).toBe(
            gone && !kept
              ? f.unread
                ? 'unread'
                : 'deleted'
              : held
                ? 'held'
                : left
                  ? 'left-out'
                  : null,
          );
          expect(isGoneIn(view, item), label).toBe(gone);
          expect(isHiddenIn(view, item, hidden), label).toBe(gone || held);
          expect(isPassedIn(view, item, hidden), label).toBe(
            gone || (format && held),
          );
          expect(isGoneFromLineIn(view, item, hidden), label).toBe(
            gone && !kept,
          );
          expect(isShownIn(view, item, hidden), label).toBe(
            (!gone || kept) && !held,
          );
          expect(isShownIn(view, item, hidden), label).toBe(
            whyNotShown(view, item, hidden) === null,
          );
          expect(isStoredIn(view, item, hidden), label).toBe(!gone && !kept);
          expect(isLiveContent(view, item), label).toBe(
            !gone && item.countable,
          );
          expect(isShownContent(view, item, leftOut), label).toBe(
            !gone && item.countable && !left,
          );
          expect(isLeftOutIn(view, item, leftOut), label).toBe(left);
          expect(isHeld(item, hidden), label).toBe(held);
          expect(isHeldFormat(item, hidden), label).toBe(format && held);
          expect(isHeldFormatIn(view, item, hidden), label).toBe(
            format && held && !gone,
          );
          // What showed before a change being read: Yjs as it is (no view),
          // less what the change did.
          const raw = factsOf(null, item, hidden);
          for (const change of [null, s.change]) {
            expect(wasShownBefore(item, hidden, change), label).toBe(
              !raw.held &&
                (raw.deleted
                  ? raw.kept ||
                    (change !== null && change.deleteSet.hasId(item.id))
                  : change === null || !change.insertSet.hasId(item.id)),
            );
          }
          expect(isKept(item, hidden), label).toBe(kept);
          expect(inLane(view, item, 'raw', hidden), label).toBe(!item.deleted);
          expect(inLane(view, item, 'stored', hidden), label).toBe(
            !gone && !kept,
          );
          expect(inLane(view, item, 'shown', hidden), label).toBe(
            !gone && !held,
          );
          // With no hold and nothing left out, the filter is the view's
          // own answer.
          expect(whyNotShown(view, item, null) === null, label).toBe(!gone);
          expect(isShownIn(view, item, null), label).toBe(!gone);
        }
      }
      hidden.releaseKeeps();
    });
  }

  test('an item that is gone is never left out, whatever the predicate says', () => {
    const s = scene(false);
    const asked: Y.Item[] = [];
    const all: LeftOut = item => {
      asked.push(item);
      return true;
    };
    for (const view of [s.view, s.bare, null]) {
      for (const [name, item] of s.items) {
        const f = factsOf(view, item, s.hidden, all);
        const gone = f.unread || f.deleted;
        expect(f.leftOut, name).toBe(!gone && item.countable);
        expect(isLeftOutIn(view, item, all), name).toBe(f.leftOut);
        expect(isShownContent(view, item, all), name).toBe(false);
        expect(shownLengthIn(view, item, s.hidden, all), name).toBe(0);
        expect(
          whyNotShown(view, item, s.hidden, all) === 'left-out',
          name,
        ).toBe(f.leftOut && !f.held);
      }
    }
    // The predicate runs in the editor, and is never asked of an item that
    // is not live content.
    expect(asked.length).toBeGreaterThan(0);
    for (const item of asked) {
      expect(item.countable).toBe(true);
    }
    for (const view of [s.view, s.bare, null]) {
      asked.length = 0;
      for (const item of s.items.values()) {
        isLeftOutIn(view, item, all);
        isShownContent(view, item, all);
      }
      for (const item of asked) {
        expect(isGoneIn(view, item)).toBe(false);
      }
    }
    s.hidden.releaseKeeps();
  });

  for (const gc of [false, true]) {
    test(`the walks count and stop by the filter (gc ${gc})`, () => {
      const s = scene(gc);
      const {hidden, leftOut, root} = s;
      const all: Y.Item[] = [];
      for (let it = root._start; it !== null; it = it.right) {
        all.push(it);
      }
      for (const view of [s.view, s.bare, null]) {
        for (const lo of [leftOut, null]) {
          for (const h of [hidden, null]) {
            let sum = 0;
            for (let i = all.length; i >= 0; i--) {
              const from = i === all.length ? null : all[i];
              if (from !== null) {
                sum += shownLengthIn(view, from, h, lo);
              }
              expect(countShown(view, from, null, h, lo)).toBe(sum);
              expect(countShown(view, from, from, h, lo)).toBe(0);
            }
            expect(countShown(view, all[0], all[2], h, lo)).toBe(
              shownLengthIn(view, all[0], h, lo) +
                shownLengthIn(view, all[1], h, lo),
            );
          }
        }
        let prev: Y.Item | null = null;
        for (const it of all) {
          expect(prevShownEnd(view, it, hidden)).toBe(prev);
          if (isShownEndIn(view, it, hidden)) {
            prev = it;
          }
        }
        expect(prevShownEnd(view, null, hidden)).toBe(null);
      }
      // The scene has an end the editor shows and ends it does not.
      expect(prevShownEnd(s.view, null, hidden)).toBe(null);
      expect(
        all.filter(it => isShownEndIn(s.view, it, hidden)).length,
      ).toBeGreaterThan(0);
      expect(
        all.filter(it => isShownEndIn(null, it, null)).length,
      ).toBeGreaterThan(
        all.filter(it => isShownEndIn(s.view, it, hidden)).length,
      );
      hidden.releaseKeeps();
    });
  }
});

// The sources, read with the TypeScript compiler (see utils/shownGuard):
// what a name resolves to decides, so a comment, a line break, an alias or
// a wrapper neither hides a use nor makes one.
describe('no other module decides what is shown', () => {
  test('the hold, the unread changes and a left-out predicate are asked only through Shown, and no condition joins two lanes', () => {
    const found = scanShownGuard();
    // The lanes, a closed list: a new one is added here, and to the table
    // at the head of Shown.
    expect(found.lanes).toEqual([
      '$isLeftOutInline',
      'hasLiveContent',
      'inLane',
      'isGoneFromLineIn',
      'isGoneIn',
      'isHeld',
      'isHeldFormat',
      'isHeldFormatIn',
      'isHeldInPart',
      'isHiddenIn',
      'isKept',
      'isLeftOutIn',
      'isLiveContent',
      'isPassedIn',
      'isShownContent',
      'isShownEndIn',
      'isShownIn',
      'isStoredIn',
      'wasShownBefore',
    ]);
    // Every use outside Shown, Hidden and Unread of what only the filter
    // may ask. None of the four decides whether a sequence item is shown:
    expect(found.asks).toEqual([
      // splits the items at the bounds of what the writes deleted too;
      "Binding.ts YBinding#splitAtUnread: a view's removed",
      // an attribute's value before the unread changes (a value is not an
      // item of a sequence);
      "Seen.ts attrItem: the unread changes' inserted",
      "Seen.ts attrsBeforeIn: the unread changes' inserted",
      // records a write's delete of what an unread change deleted.
      "Seen.ts deleteItemIn: a view's removed",
    ]);
    // Every condition that joins two lanes, a wrapper of a lane counting
    // as the lane.
    expect(found.joins).toEqual([
      // Two items: whether `x` is a held format item, or an end whose
      // opener is gone (isValidEnd asks isGoneIn of the opener).
      'Cursor.ts Cursor#emptyRunEnd: isGoneIn + isHeldFormat',
      // Where a run a format change writes stops: at a held item of its
      // key (isHeldFormatIn), or at an item of the key the cursor does not
      // pass (isPassedIn) that is a boundary or a clearer (isGoneIn, of an
      // end's opener). Each lane's answer is used whole.
      'Cursor.ts Cursor#formatCovered: isGoneIn + isHeldFormatIn + isPassedIn',
      'Cursor.ts Cursor#formatCovered: isGoneIn + isHeldFormatIn + isPassedIn',
    ]);
  }, 120_000);

  test('the scan finds a use through a line break, an alias, a destructuring, a look-alike type and a wrapper, and none in a comment or a string', () => {
    const probe = `
import type {Item} from '@y/y';

import {Hidden} from './Hidden';
import {isGoneIn, isHeld, type LeftOut} from './Shown';
import * as unread from './Unread';
import {inserted as wasInserted, type View} from './Unread';

// hidden.hides(item) in a comment is not a use
/* inserted(view, item) && view.removed.hasId(item.id) */
export function inAString(view: View | null, a: Item, b: Item): boolean {
  const text = 'hidden.hides(item) && isHeld(item, hidden)';
  // One lane asked of two items is not a join.
  return text.length > 0 && (isGoneIn(view, a) || isGoneIn(view, b));
}
export function overLines(hidden: Hidden, item: Item): boolean {
  return hidden
    // a comment between
    .hides(
      item,
    );
}
export function aliased(hidden: Hidden, item: Item): boolean {
  const ask = hidden.keeps;
  return ask.call(hidden, item);
}
export function destructured(hidden: Hidden, item: Item): boolean {
  const {overlaps: o} = hidden;
  return o.call(hidden, item);
}
export function indexed(hidden: Hidden, item: Item): boolean {
  return hidden['runs'](item).length > 1;
}
export function lookAlike(
  held: {hides(item: Item): boolean} | null,
  item: Item,
): boolean {
  return held !== null && held.hides(item);
}
export function renamed(view: View, item: Item): boolean {
  return wasInserted(view, item);
}
export function namespaced(view: View, item: Item): boolean {
  return unread.deleted(view, item);
}
export function removedSet(view: View, item: Item): boolean {
  return view.removed.hasId(item.id);
}
export function viewKeeps(view: View, item: Item): boolean {
  return view.keeps !== null && view.keeps(item);
}
export function predicate(leftOut: LeftOut, item: Item): boolean {
  return leftOut !== null && leftOut(item);
}
const gone = (view: View | null, item: Item) => isGoneIn(view, item);
const notGone = (view: View | null, item: Item) => !gone(view, item);
export function joined(
  view: View | null,
  hidden: Hidden,
  item: Item,
): boolean {
  return (
    notGone(view, item) &&
    // through two wrappers, over lines
    isHeld(item, hidden)
  );
}
`;
    const found = scanShownGuard({'ZzProbe.ts': probe});
    const ofProbe = (list: string[]) =>
      list.filter(line => line.startsWith('ZzProbe.ts '));
    expect(ofProbe(found.asks)).toEqual([
      "ZzProbe.ts aliased#ask: the hold's keeps",
      "ZzProbe.ts destructured: the hold's overlaps",
      "ZzProbe.ts indexed: the hold's runs",
      "ZzProbe.ts lookAlike: the hold's hides",
      "ZzProbe.ts namespaced: the unread changes' deleted",
      "ZzProbe.ts overLines: the hold's hides",
      'ZzProbe.ts predicate: a left-out predicate',
      "ZzProbe.ts removedSet: a view's removed",
      "ZzProbe.ts renamed: the unread changes' inserted",
      "ZzProbe.ts viewKeeps: a view's keeps",
      "ZzProbe.ts viewKeeps: a view's keeps",
    ]);
    expect(ofProbe(found.joins)).toEqual([
      'ZzProbe.ts joined: isGoneIn + isHeld',
    ]);
  }, 120_000);
});
