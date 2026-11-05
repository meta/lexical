/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// An array of a shape layout 3 does not write (see catalog/coveredValues)
// is an end this release does not understand: a later layout's, or a raw
// writer's. The binding never rewrites what it does not understand: copy
// repair (an undo's or redo's copy, a raw writer's format() copy, the repair
// before a write in an app's transaction) leaves every copy's value as it
// is, and the binding's writes around and over such items (formats, typing,
// deletes, undo and redo) never re-point, copy or delete them. An object
// shaped like an array is a value, and the binding's writes treat it as any
// value: a format over its run deletes it where they delete a plain value,
// and the format's undo brings it back (gc off and on).

import {$toggleLink} from '@lexical/link';
import {$patchStyleText} from '@lexical/selection';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc} from '../../..';
import {covered, repairPendingCopies} from '../../../internal/Ident';
import {
  ARRAY_SHAPED_VALUES,
  isReservedShape,
  RESERVED_END_SHAPES,
} from '../../catalog/coveredValues';
import {$selectIn, expectConverged, setup} from '../../utils/harness';
import {lineView} from '../../utils/rawFormats';

const rootOf = (doc: Y.Doc) => doc.get('lexical-y');

/** Store `key`=`value` right before the first `text` of the root, raw. */
function storeBefore(
  doc: Y.Doc,
  text: string,
  key: string,
  value: unknown,
  origin: unknown = 'raw',
): Y.Item {
  let item: Y.Item | null = null;
  doc.transact(tr => {
    let right: Y.Item | null = null;
    for (let it = rootOf(doc)._start; it; it = it.right) {
      if (!it.deleted && it.content instanceof Y.ContentString) {
        const at = it.content.str.indexOf(text);
        if (at >= 0) {
          right =
            at === 0
              ? it
              : Y.getItemCleanStart(
                  tr,
                  Y.createID(it.id.client, it.id.clock + at),
                );
          break;
        }
      }
    }
    if (right === null) {
      throw new Error(`no text ${text}`);
    }
    const left: Y.Item | null = right.left;
    item = new Y.Item(
      Y.createID(doc.clientID, doc.store.getClock(doc.clientID)),
      left,
      left && left.lastId,
      right,
      right.id,
      rootOf(doc),
      null,
      new Y.ContentFormat(key, value as object),
    );
    item.integrate(tr, 0);
  }, origin);
  return item!;
}

/** Every format item (live or deleted) of `doc` holding a reserved shape. */
function reservedItems(doc: Y.Doc): Y.Item[] {
  const out: Y.Item[] = [];
  doc.store.clients.forEach(structs => {
    for (const s of structs) {
      if (
        s instanceof Y.Item &&
        s.content instanceof Y.ContentFormat &&
        covered(s.content.key) &&
        isReservedShape(s.content.value)
      ) {
        out.push(s);
      }
    }
  });
  return out;
}

/** An item's id, key and value, by value (a typed array as JSON writes it). */
const stored = (it: Y.Item) =>
  `${it.id.client}.${it.id.clock} ${(it.content as Y.ContentFormat).key}=${JSON.stringify(
    (it.content as Y.ContentFormat).value,
  )}${it.deleted ? ' (deleted)' : ''}`;

/** Sync three documents both ways. */
function syncDocs(docs: Y.Doc[]): void {
  for (let round = 0; round < 2; round++) {
    for (const a of docs) {
      for (const b of docs) {
        if (a !== b) {
          Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
        }
      }
    }
  }
}

const KEYS = ['f:bold', 'p:style', 'w:link'] as const;
/** A raw writer's plain value of each family (an unpaired run). */
const RAW: Record<(typeof KEYS)[number], unknown> = {
  'f:bold': true,
  'p:style': 'color: red;',
  'w:link': {url: 'https://x.test'},
};

for (const gc of [false, true]) {
  describe(`reserved end shapes stay as stored (gc ${gc ? 'on' : 'off'})`, () => {
    test('the binding writes formats, text and deletes over them, and undoes and redoes those writes, without touching them', async () => {
      for (const [label, make] of RESERVED_END_SHAPES) {
        for (const key of KEYS) {
          const what = `${label} under ${key}`;
          const t = await setup(
            () =>
              $getRoot().append(
                $createParagraphNode().append($createTextNode('abcdef')),
              ),
            {gc},
          );
          // A raw writer's unpaired value before "b", the reserved value
          // before "c", and a raw null before "e": the formats below delete
          // unpaired items whose run ends inside their range.
          storeBefore(t.a.doc, 'bcdef', key, RAW[key]);
          const value = make();
          const item = storeBefore(t.a.doc, 'cdef', key, value);
          storeBefore(t.a.doc, 'ef', key, null);
          await t.sync();
          const before = [item].map(stored);
          // A formats a range over it, with each family.
          t.a.update(() => {
            $selectIn([0], 1, 5).formatText('bold');
            $setSelection(null);
          });
          t.a.update(() => {
            $patchStyleText($selectIn([0], 1, 5), {color: 'blue'});
            $setSelection(null);
          });
          t.a.update(() => {
            $selectIn([0], 1, 5);
            $toggleLink('https://y.test');
            $setSelection(null);
          });
          await t.sync();
          // B types right where the reserved value is, and changes bold
          // over part of the range; A deletes around it.
          t.b.update(() => {
            $selectIn([0], 2, 2).insertText('XY');
            $setSelection(null);
          });
          t.b.update(() => {
            $selectIn([0], 0, 4).formatText('bold');
            $setSelection(null);
          });
          await t.sync();
          t.a.update(() => {
            $selectIn([0], 1, 6).removeText();
            $setSelection(null);
          });
          await t.sync();
          // Every write undone, then redone, on both clients.
          for (const peer of [t.a, t.b]) {
            for (let i = 0; i < 6 && peer.binding.undoManager!.canUndo(); i++) {
              peer.undo();
            }
          }
          await t.sync();
          for (const peer of [t.b, t.a]) {
            for (let i = 0; i < 6 && peer.binding.undoManager!.canRedo(); i++) {
              peer.binding.redo();
            }
          }
          await t.sync();
          for (const peer of t.peers) {
            // The same item, live, with the same value; no copy of it.
            expect(reservedItems(peer.doc).map(stored), what).toEqual(before);
          }
          // The very value A stored.
          expect(
            Object.is((item.content as Y.ContentFormat).value, value),
            what,
          ).toBe(true);
          await expectConverged(t.peers);
        }
      }
    });

    test("copy repair leaves an undo's copy, a redo's copy and a raw writer's format() copy as they are", async () => {
      for (const [label, make] of RESERVED_END_SHAPES) {
        for (const key of KEYS) {
          const what = `${label} under ${key}`;
          const t = await setup(
            () =>
              $getRoot().append(
                $createParagraphNode().append($createTextNode('abcdef')),
              ),
            {gc},
          );
          // A raw writer's document: copy repair is installed.
          const raw = createYDoc(null, {gc});
          raw.clientID = 777;
          syncDocs([t.a.doc, raw]);
          const origin = {raw: true};
          const um = new Y.UndoManager(rootOf(raw), {
            captureTimeout: 0,
            trackedOrigins: new Set([origin]),
          });
          const value = make();
          const original = storeBefore(raw, 'cdef', key, value, origin);
          // Undone, then redone: the redo restores it as a copy that shares
          // its value.
          um.undo();
          um.redo();
          const copy = raw.store.getItem(original.redone!) as Y.Item;
          expect(copy.deleted, what).toBe(false);
          expect(
            Object.is((copy.content as Y.ContentFormat).value, value),
            what,
          ).toBe(true);
          // A raw format() over "d", inside the reserved value's Yjs range,
          // restores that value after "d": another copy of it.
          raw.transact(() => rootOf(raw).format(3, 1, {[key]: null}));
          const copies = reservedItems(raw).filter(
            it => (it.content as Y.ContentFormat).value === value,
          );
          expect(copies.length, what).toBeGreaterThanOrEqual(2);
          // The repair a binding runs before a write inside an app's
          // transaction, on a redo's copy in that transaction.
          um.undo();
          raw.transact(() => {
            um.redo();
            repairPendingCopies(raw);
            for (const it of reservedItems(raw)) {
              expect(
                Object.is((it.content as Y.ContentFormat).value, value),
                what,
              ).toBe(true);
            }
          });
          // (Deleted ones are collected where gc is on.)
          const live = (doc: Y.Doc) =>
            reservedItems(doc)
              .filter(it => !it.deleted)
              .map(stored);
          const kept = live(raw);
          expect(kept.length, what).toBeGreaterThanOrEqual(2);
          for (const it of reservedItems(raw)) {
            expect(
              Object.is((it.content as Y.ContentFormat).value, value),
              what,
            ).toBe(true);
          }
          // The peers receive every copy as stored, and read each as a
          // clearer: "abcdef" stays plain.
          syncDocs([raw, t.a.doc]);
          await t.sync();
          for (const peer of t.peers) {
            expect(live(peer.doc), what).toEqual(kept);
            expect(peer.describe(), what).toBe('paragraph("abcdef")');
          }
          await expectConverged(t.peers);
          um.destroy();
          raw.destroy();
        }
      }
    });

    test('an object shaped like an array is a value: a format over its run deletes it as it deletes any other object, and its undo brings it back', async () => {
      // What became of a raw value stored over "cd" (a null before "e" ends
      // its run) when A formats "bcde", then undoes that. The control is an
      // object that is not shaped like an array, `{}`: it shows as the
      // objects do (no format bit, no style, a link with no fields), so A's
      // edit formats the same range.
      const fateOf = async (key: (typeof KEYS)[number], value: unknown) => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append($createTextNode('abcdef')),
            ),
          {gc},
        );
        const item = storeBefore(t.a.doc, 'cdef', key, value);
        storeBefore(t.a.doc, 'ef', key, null);
        await t.sync();
        const shown = lineView(t.a);
        t.a.update(() => {
          const selection = $selectIn([0], 1, 5);
          if (key === 'f:bold') {
            selection.formatText('bold');
          } else if (key === 'p:style') {
            $patchStyleText(selection, {color: 'blue'});
          } else {
            $toggleLink('https://y.test');
          }
          $setSelection(null);
        });
        await t.sync();
        const deleted = item.deleted;
        t.a.undo();
        await t.sync();
        const copy =
          item.redone === null
            ? null
            : (t.a.doc.store.getItem(item.redone) as Y.Item);
        await expectConverged(t.peers);
        return {
          deleted,
          restored: copy !== null && !copy.deleted,
          sameValue:
            copy !== null &&
            Object.is((copy.content as Y.ContentFormat).value, value),
          shownAgain: lineView(t.a) === shown,
        };
      };
      for (const key of KEYS) {
        const plain = await fateOf(key, {});
        expect(plain, key).toEqual({
          deleted: true,
          restored: true,
          sameValue: true,
          shownAgain: true,
        });
        for (const [label, make] of ARRAY_SHAPED_VALUES) {
          expect(await fateOf(key, make()), `${label} under ${key}`).toEqual(
            plain,
          );
        }
      }
    });
  });
}
