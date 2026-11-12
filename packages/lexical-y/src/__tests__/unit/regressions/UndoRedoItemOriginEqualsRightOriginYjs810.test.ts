/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// Collaborators can end with different text after one of them undoes a
// deletion, when the undo restores text that an earlier undo had put back and
// that was split since (yjs#810, also yjs#823 and meta/lexical#9748). Yjs's
// UndoManager (redoItem) then writes the restored item with the same item as
// both its left origin and its right origin. Each client places such an item
// by how that neighbour is split in its own document, so documents holding the
// same items can disagree on their order.
//
// Recorded from a three-client collaboration fuzz session (seed 2688563717):
// client A deleted a table row while offline, came back online while the
// others edited elsewhere (one inserted a column next to that row), and undid
// the deletion. Its undo restored "t74z" (an earlier undo's copy of the text,
// since split by an edit) with origin = rightOrigin. The fixture holds two
// updates: the one A's document integrated and the one a collaborator's
// document integrated, merged from each client's own update history. They
// contain the same items and differ only in how those items are split. After
// the two documents sync, A reads "t12zt74z t13z" in the table cell and the
// collaborator reads "t12z t74zt13z".
//
// No editor code runs here: this is Yjs alone. Main writes the same item with
// origin equal to rightOrigin on this session; whether the receivers diverge
// depends on how the neighbouring items are laid out, and with layout 2's
// item boundaries the collaborators happened to place it alike. The fix
// belongs in Yjs (the v14 port of yjs#810's redoItem fixes stops such items
// from being written; it cannot change an update that already holds one, so
// these cells stay failing on recorded data and document the class). Run
// again live (the soak's struct profile, block ids on), session 2688563717
// still diverges with gc off and on; with the v14 port of yjs#810's redoItem
// fixes applied to @y/y, it converges.

import * as Y from '@y/y';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {expect, test} from 'vitest';

const REMOTE = Symbol('remote');
// The recorded updates (not fuzz scripts: they sit outside fuzz/, which
// FuzzReplay replays).
const FIXTURE = path.join(
  __dirname,
  'fixtures/yjs810/diverge-undo-origin-equals-right-origin-yjs810-s2688563717.json',
);
const FIXTURE_2 = path.join(
  __dirname,
  'fixtures/yjs810/diverge-undo-origin-equals-right-origin-yjs810-s2699777269.json',
);

type Fixture = {
  a: string;
  b: string;
  clientA: number;
  clientB: number;
  gc: boolean;
  root: string;
};

function load(file = FIXTURE): Fixture {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function docFrom(update: string, clientID: number, gc: boolean): Y.Doc {
  const doc = new Y.Doc({gc});
  doc.clientID = clientID;
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(update, 'base64')), REMOTE);
  return doc;
}

function contentOf(doc: Y.Doc, root: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return JSON.stringify((doc as any).get(root).toJSON());
}

function sync(a: Y.Doc, b: Y.Doc) {
  for (let i = 0; i < 2; i++) {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), REMOTE);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), REMOTE);
  }
}

test.fails(
  'yjs#810: documents with the same items converge after an undo restored split text (Yjs redoItem writes origin = rightOrigin)',
  () => {
    const f = load();
    const a = docFrom(f.a, f.clientA, f.gc);
    const b = docFrom(f.b, f.clientB, f.gc);
    sync(a, b);
    expect(Buffer.from(Y.encodeStateVector(a))).toEqual(
      Buffer.from(Y.encodeStateVector(b)),
    );
    expect(contentOf(b, f.root)).toBe(contentOf(a, f.root));
  },
);

test.fails(
  'yjs#810: no item holds the same item as its origin and its right origin (Yjs redoItem)',
  () => {
    const f = load();
    const doc = docFrom(f.a, f.clientA, f.gc);
    const same: string[] = [];
    type Struct = {
      id: {client: number; clock: number};
      origin: {client: number; clock: number} | null;
      rightOrigin: {client: number; clock: number} | null;
    };
    const clients = (
      doc as unknown as {store: {clients: Map<number, Struct[]>}}
    ).store.clients;
    for (const structs of clients.values()) {
      for (const item of structs) {
        const o = item.origin;
        const r = item.rightOrigin;
        if (o && r && o.client === r.client && o.clock === r.clock) {
          same.push(`${item.id.client}:${item.id.clock}`);
        }
      }
    }
    expect(same).toEqual([]);
  },
);

// A second recorded session (seed 2699777269, gc on): a client moved four
// words while offline and undid the move after coming back, while a
// collaborator's stale edit rewrote one of the restored words (t14z ->
// t65z), which split the earlier undo's copy. Later the client deleted a
// table column over that text and undid the deletion. The undo restored " "
// and "t65z" with a right origin to the LEFT of their origin (Yjs
// UndoManager redoItem), and collaborators placed them differently: after
// syncing, the client reads "t12zt13z t14zt65z t15z " in the table cell and
// the collaborator reads "t12zt13z t14z t15zt65z ". With the v14 port of
// yjs#810's redoItem fixes the same session converges (no such item is
// written); main writes the same kind of item here, and its item boundaries
// happened to place it alike.

test.fails(
  'yjs#810 (seed 2699777269): documents converge after an undo restored text an edit split (Yjs redoItem writes a right origin left of the origin)',
  () => {
    const f = load(FIXTURE_2);
    const a = docFrom(f.a, f.clientA, f.gc);
    const b = docFrom(f.b, f.clientB, f.gc);
    sync(a, b);
    expect(Buffer.from(Y.encodeStateVector(a))).toEqual(
      Buffer.from(Y.encodeStateVector(b)),
    );
    expect(contentOf(b, f.root)).toBe(contentOf(a, f.root));
  },
);

test.fails(
  'yjs#810 (seed 2699777269): every item has its right origin to the right of its origin (Yjs redoItem)',
  () => {
    type ID = {client: number; clock: number};
    type ListItem = {
      id: ID;
      length: number;
      origin: ID | null;
      rightOrigin: ID | null;
      parent: {_start: ListItem | null} | null;
      parentSub: string | null;
      right: ListItem | null;
    };
    const f = load(FIXTURE_2);
    const doc = docFrom(f.a, f.clientA, f.gc);
    const clients = (
      doc as unknown as {store: {clients: Map<number, ListItem[]>}}
    ).store.clients;
    const holds = (it: ListItem, id: ID) =>
      id.client === it.id.client &&
      id.clock >= it.id.clock &&
      id.clock < it.id.clock + it.length;
    const bad: string[] = [];
    for (const structs of clients.values()) {
      for (const item of structs) {
        const o = item.origin;
        const r = item.rightOrigin;
        if (!o || !r || !item.parent || item.parentSub) {
          continue;
        }
        // The positions of the origin and the right origin in the parent's
        // list.
        let io = -1;
        let ir = -1;
        let i = 0;
        for (let n = item.parent._start; n !== null; n = n.right, i++) {
          if (io < 0 && holds(n, o)) {
            io = i;
          }
          if (ir < 0 && holds(n, r)) {
            ir = i;
          }
        }
        if (io >= 0 && ir >= 0 && ir <= io) {
          bad.push(`${item.id.client}:${item.id.clock}`);
        }
      }
    }
    expect(bad).toEqual([]);
  },
);
