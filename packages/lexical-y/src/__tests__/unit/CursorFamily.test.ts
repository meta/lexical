/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import * as Y from '@y/y';
import {describe, expect, test, vi} from 'vitest';

import {Cursor} from '../../internal/Cursor';

// A layout that stores one attribute under several format keys (here a set
// stored one key per member, `m|<member>` = true) names them one family
// (see formatFamily). The write cursor's rules for format items then hold
// for the attribute as they hold for a key stored whole (see
// Cursor#format and Cursor#minimizeFormatChanges).

vi.mock('../../internal/Schema', async importOriginal => {
  const actual = await importOriginal<typeof import('../../internal/Schema')>();
  return {
    ...actual,
    formatFamily: (key: string) => (key.startsWith('m|') ? 'm' : key),
  };
});

const m = (member: string) => `m|${member}`;

function doc(id: number): Y.Doc {
  const d = new Y.Doc();
  d.clientID = id;
  // As the binding's containers (see YBinding#beforeObserverCalls).
  d.cleanupFormatting = false;
  return d;
}

function write(d: Y.Doc, at: number, op: (cursor: Cursor) => void) {
  d.transact(tr => {
    const cursor = new Cursor(tr, d.get('t'), null, new Map());
    cursor.advance(at);
    op(cursor);
  });
}

function exchange(docs: Y.Doc[]) {
  for (const a of docs) {
    for (const b of docs) {
      if (a !== b) {
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
      }
    }
  }
}

/** Each character with the members it holds. */
function members(d: Y.Doc): string[] {
  const out: string[] = [];
  const {children} = d.get('t').toDelta().toJSON() as {
    children: {insert: string; format?: Record<string, unknown>}[];
  };
  for (const op of children) {
    const held = Object.entries(op.format ?? {})
      .filter(([k, v]) => k.startsWith('m|') && v === true)
      .map(([k]) => k.slice(2))
      .sort();
    for (const ch of op.insert) {
      out.push(held.length > 0 ? `${ch}[${held.join(',')}]` : ch);
    }
  }
  return out;
}

const liveFormatItems = (d: Y.Doc) => {
  let n = 0;
  for (let it = d.get('t')._start; it !== null; it = it.right) {
    if (!it.deleted && it.content instanceof Y.ContentFormat) {
      n++;
    }
  }
  return n;
};

describe('a set stored one format key per member', () => {
  for (const ids of [
    [1, 2, 3],
    [3, 2, 1],
  ]) {
    test(`a comment resolved over "b " ‖ plain "x" typed between them: the space stays without it (ids ${ids})`, () => {
      const [a, b, c] = ids.map(doc);
      const t = a.get('t');
      t.insert(0, 'a');
      t.insert(1, 'b', {[m('C3')]: true, [m('S0')]: true});
      t.insert(2, ' ', {[m('C3')]: true});
      t.insert(3, 'cd');
      exchange([a, b, c]);
      write(b, 1, cursor => cursor.format(2, {[m('C3')]: null}));
      write(c, 2, cursor => cursor.insert(new Y.ContentString('x'), {}));
      exchange([a, b, c]);
      for (const d of [a, b, c]) {
        expect(members(d)).toEqual(['a', 'b[S0]', 'x', ' ', 'c', 'd']);
      }
    });
  }

  test('words of new members typed and deleted again at one place leave two format items each', () => {
    const a = doc(1);
    a.get('t').insert(0, 'start middle end');
    const counts: number[] = [];
    for (let i = 1; i <= 60; i++) {
      write(a, 6, cursor =>
        cursor.insert(new Y.ContentString('word'), {[m(`c${i}`)]: true}),
      );
      write(a, 6, cursor => cursor.delete(4));
      if (i % 20 === 0) {
        counts.push(liveFormatItems(a));
      }
    }
    expect(members(a).join('')).toBe('start middle end');
    // Each word's opener and closer stay (a delete keeps the format items
    // around and inside what it deletes, D86): 40, 80 and 120.
    expect(counts).toEqual([40, 80, 120]);
  });

  // S6-9: where a run keeps a unit of a family of several keys, the value
  // its keys have at the end of that place stays, as a whole value's item
  // there gives it. A run kept one member's opener of a word whose two
  // members two clients added, so an undo of the word's delete, after a
  // peer's later delete next to it collapsed the run, brought the word back
  // with one member.
  for (const order of ['in turn', 'at once']) {
    for (const ids of [
      [1, 3],
      [3, 1],
    ]) {
      test(`a word two clients gave a member each (${order}), deleted, a peer deletes the word before it, the delete undone: the word has both (ids ${ids})`, () => {
        const [a, c] = ids.map(doc);
        a.get('t').insert(0, 't4z t5z ');
        exchange([a, c]);
        write(a, 4, cursor => cursor.format(3, {[m('ma')]: true}));
        if (order === 'in turn') {
          exchange([a, c]);
        }
        write(c, 4, cursor => cursor.format(3, {[m('mc')]: true}));
        exchange([a, c]);
        const undo = new Y.UndoManager(a.get('t'), {
          trackedOrigins: new Set(['a']),
        });
        a.transact(tr => {
          const cursor = new Cursor(tr, a.get('t'), null, new Map());
          cursor.advance(4);
          cursor.delete(3);
        }, 'a');
        exchange([a, c]);
        write(c, 0, cursor => cursor.delete(4));
        exchange([a, c]);
        undo.undo();
        exchange([a, c]);
        for (const d of [a, c]) {
          expect(members(d)).toEqual(['t[ma,mc]', '5[ma,mc]', 'z[ma,mc]', ' ']);
        }
      });
    }
  }
});
