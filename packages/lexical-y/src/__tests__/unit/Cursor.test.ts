/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import * as Y from '@y/y';
import {describe, expect, test} from 'vitest';

import {Cursor} from '../../internal/Cursor';

// The binding's write cursor reimplements Yjs' text-position operations on
// items (Yjs exports no way to start them from a known item). It must stay
// equivalent to Y.Node#applyDelta: the same operations through both, from
// the same client, give the same content. It keeps format items Yjs removes
// as redundant where they bound content outside the edit (see
// Cursor#collapseGap and Cursor#format), so it holds at least as many. Run
// on every @y/y version bump.

type Op =
  | {kind: 'insert'; at: number; text: string; formats: Record<string, unknown>}
  | {kind: 'delete'; at: number; len: number}
  | {kind: 'format'; at: number; len: number; formats: Record<string, unknown>};

const FORMATS: Record<string, unknown>[] = [
  {},
  {'f:bold': true},
  {'f:italic': true},
  {'f:bold': true, 'f:italic': true},
  {'w:link': {url: 'https://a'}},
  {'f:bold': true, 'w:link': {url: 'https://b'}},
];

function randomOps(seed: number, count: number): Op[] {
  let x = seed;
  const rnd = () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
  const ops: Op[] = [];
  let len = 0;
  for (let i = 0; i < count; i++) {
    const r = rnd();
    const formats = FORMATS[Math.floor(rnd() * FORMATS.length)];
    if (r < 0.5 || len === 0) {
      const text = 'abcdefgh'.slice(0, 1 + Math.floor(rnd() * 5));
      ops.push({
        at: Math.floor(rnd() * (len + 1)),
        formats,
        kind: 'insert',
        text,
      });
      len += text.length;
    } else if (r < 0.75) {
      const at = Math.floor(rnd() * len);
      const n = 1 + Math.floor(rnd() * Math.min(4, len - at));
      ops.push({at, kind: 'delete', len: n});
      len -= n;
    } else {
      const at = Math.floor(rnd() * len);
      const n = 1 + Math.floor(rnd() * Math.min(6, len - at));
      const unformat: Record<string, unknown> = {};
      for (const k of Object.keys(formats)) {
        unformat[k] = rnd() < 0.3 ? null : formats[k];
      }
      ops.push({at, formats: unformat, kind: 'format', len: n});
    }
  }
  return ops;
}

function viaApplyDelta(doc: Y.Doc, ops: Op[]) {
  const text = doc.get('t');
  for (const op of ops) {
    if (op.kind === 'insert') {
      text.insert(op.at, op.text, {...op.formats});
    } else if (op.kind === 'delete') {
      text.delete(op.at, op.len);
    } else {
      text.format(op.at, op.len, {...op.formats});
    }
  }
}

function viaCursor(doc: Y.Doc, ops: Op[]) {
  const text = doc.get('t');
  for (const op of ops) {
    doc.transact(tr => {
      const cursor = new Cursor(tr, text, null, new Map());
      cursor.advance(op.at);
      if (op.kind === 'insert') {
        cursor.insert(new Y.ContentString(op.text), {...op.formats});
      } else if (op.kind === 'delete') {
        cursor.delete(op.len);
      } else {
        cursor.format(op.len, {...op.formats});
      }
    });
  }
}

const liveFormatItems = (doc: Y.Doc) => {
  let n = 0;
  for (let it = doc.get('t')._start; it !== null; it = it.right) {
    if (!it.deleted && it.content instanceof Y.ContentFormat) {
      n++;
    }
  }
  return n;
};

describe('@lexical/y write cursor', () => {
  test.each(Array.from({length: 60}, (_, i) => i + 1))(
    'matches Y.Node#applyDelta (seed %i)',
    seed => {
      const ops = randomOps(seed, 40);
      const a = new Y.Doc();
      const b = new Y.Doc();
      a.clientID = 7;
      b.clientID = 7;
      viaApplyDelta(a, ops);
      viaCursor(b, ops);
      expect(b.get('t').toDelta().toJSON()).toEqual(
        a.get('t').toDelta().toJSON(),
      );
      expect(liveFormatItems(b)).toBeGreaterThanOrEqual(liveFormatItems(a));
    },
  );
});

// A format change followed by a delete on one cursor, after its range's last
// content, past items of a key it does not change: the delete keeps every
// format item there (D86), so text a peer types after the first of them keeps
// its value.
describe('a format change then a delete on one cursor', () => {
  type Raw = {
    forward(): void;
    newItem(content: Y.ContentFormat | Y.ContentString): Y.Item;
    right: Y.Item | null;
  };
  for (const [old, next] of [
    ['old', 'new'],
    [true, null],
  ] as const) {
    test(`a run of five items of K=${JSON.stringify(next)} after the range, K=${JSON.stringify(old)} before it: they stay`, () => {
      const doc = new Y.Doc();
      doc.clientID = 7;
      doc.cleanupFormatting = false;
      const text = doc.get('t');
      const ks: Y.Item[] = [];
      let start: Y.Item | null = null;
      doc.transact(tr => {
        const raw = new Cursor(tr, text, null, new Map()) as unknown as Raw;
        const append = (content: Y.ContentFormat | Y.ContentString) => {
          const item = raw.newItem(content);
          raw.right = item;
          raw.forward();
          return item;
        };
        start = append(new Y.ContentFormat('K', old as unknown as object));
        append(new Y.ContentString('A'));
        for (let i = 0; i < 5; i++) {
          ks.push(append(new Y.ContentFormat('K', next as unknown as object)));
        }
        append(new Y.ContentString('B'));
        append(new Y.ContentString('C'));
      });
      const peer = new Y.Doc();
      peer.clientID = 8;
      peer.cleanupFormatting = false;
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
      doc.transact(tr => {
        const cursor = new Cursor(tr, text, start, new Map([['K', old]]));
        cursor.format(1, {F: true});
        expect(cursor.formats.get('K') ?? null).toBe(next);
        cursor.delete(1);
      });
      expect(ks.map(it => !it.deleted)).toEqual([true, true, true, true, true]);
      // A peer that types after the first item, offline, keeps its value.
      peer.transact(tr => {
        let anchor = peer.get('t')._start;
        while (
          anchor !== null &&
          !(
            anchor.id.client === ks[0].id.client &&
            anchor.id.clock === ks[0].id.clock
          )
        ) {
          anchor = anchor.right;
        }
        const formats = new Map<string, unknown>();
        if (next !== null) {
          formats.set('K', next);
        }
        new Cursor(tr, peer.get('t'), anchor, formats).insertPlain(
          new Y.ContentString('X'),
        );
      });
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
      const x = (
        doc.get('t').toDelta().toJSON() as {
          children: {insert: string; format?: Record<string, unknown>}[];
        }
      ).children.find(op => op.insert.includes('X'));
      expect(x?.format?.K ?? null).toBe(next);
      expect(peer.get('t').toDelta().toJSON()).toEqual(
        doc.get('t').toDelta().toJSON(),
      );
    });
  }
});
