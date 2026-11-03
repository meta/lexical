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

import {createYDoc} from '../..';
import {PLAIN_CODEC as plainCodec} from '../../internal/ReplayCodec';
import {
  pendingYRecord,
  plainRead,
  quarantineRecord as makeRecord,
  replayYRecovery,
  type YReplayCodec,
  type YReplayConfig,
} from '../../server';

// A peer-free replica whose every client id is its own: base
// values can be exact.
const quarantineRecord = (input: Parameters<typeof makeRecord>[0]) => {
  const parts = [
    ...(input.snapshot == null ? [] : [input.snapshot]),
    ...(input.deltas ?? []),
    ...(input.queue ?? []),
  ];
  const clients = new Set<number>();
  for (const u of parts) {
    for (const c of Y.decodeStateVector(
      Y.encodeStateVectorFromUpdate(u),
    ).keys()) {
      clients.add(c);
    }
  }
  return makeRecord({clients: [...clients], peers: false, ...input});
};

// The replay's rules on raw Yjs shapes:
// map-attribute base values by liveness, the ledger's scope and mapped
// deletions, sparse bases (skipped ranges), the signal transcript, and a
// container deletion (D49).

const INC = 'inc-1';

function doc(client: number, gc: boolean, state?: Uint8Array) {
  const d = createYDoc(state ?? null, {gc});
  d.clientID = client;
  return d;
}

function textOf(root: Y.Node): string {
  let s = '';
  for (let i = root._start; i !== null; i = i.right) {
    if (!i.deleted && i.content instanceof Y.ContentString) {
      s += i.content.str;
    } else if (!i.deleted && i.content instanceof Y.ContentType) {
      s += textOf(i.content.type as Y.Node);
    }
  }
  return s;
}

function record(snapshot: Uint8Array, generation: string) {
  return quarantineRecord({
    kind: 'handoff',
    receivedAt: 0,
    snapshot,
    source: {
      generation,
      incarnation: INC,
      layouts: [1, 2],
      renderer: null,
      schemaVersion: 1,
    },
  });
}

function config(
  gc: boolean,
  generation: string,
  extra: Partial<YReplayConfig> = {},
): YReplayConfig {
  return {
    baseGeneration: generation,
    gc,
    generation: `${INC}/now`,
    inPlace: true,
    incarnation: INC,
    ...extra,
  };
}

describe.each([false, true])('gc %s', gc => {
  test('map-origin: identical bytes from a replica that saw the attribute and one that saw it removed both conflict', () => {
    const run = (sawDeletion: boolean) => {
      const initial = doc(100, gc);
      const root = initial.get('lexical-y');
      root.setAttr('lexical-y:2', true);
      const node = new Y.Node('b:caption');
      root.insert(0, [node]);
      node.setAttr('p:caption', 'RED_TEXT');
      const S = Y.encodeStateAsUpdate(initial);
      const source = doc(222, gc, S);
      const authority = doc(333, gc, S);
      const block = (d: Y.Doc) =>
        (d.get('lexical-y')._start!.content as Y.ContentType).type as Y.Node;
      authority.transact(() => block(authority).deleteAttr('p:caption'));
      if (sawDeletion) {
        Y.applyUpdate(source, Y.encodeStateAsUpdate(authority));
      }
      block(source).setAttr('p:caption', 'BLUE_TEXT');
      const src = Y.encodeStateAsUpdate(source);
      const base = Y.encodeStateAsUpdate(authority);
      block(authority).setAttr('p:caption', 'RED_TEXT');
      const current = Y.encodeStateAsUpdate(authority);
      const result = replayYRecovery(
        record(src, 'g0'),
        base,
        current,
        config(gc, 'g0'),
      );
      const after = doc(9, gc, result.state);
      return {
        bytes: [src, base, current],
        conflicts: result.conflicts.map(c => [c.kind, c.key, c.reason]),
        value: block(after).getAttr('p:caption'),
      };
    };
    const a = run(false);
    const b = run(true);
    expect(a.bytes).toEqual(b.bytes);
    expect(a.conflicts).toEqual([
      ['attribute', 'p:caption', 'base value unknown'],
    ]);
    expect(b.conflicts).toEqual(a.conflicts);
    expect(a.value).toBe('RED_TEXT');
  });

  test('a deletion of a range the current document already deleted in part deletes the rest', () => {
    const base = doc(100, gc);
    base.get('lexical-y').setAttr('lexical-y:2', true);
    base.get('lexical-y').insert(0, 'abcd');
    const B = Y.encodeStateAsUpdate(base);
    const source = doc(222, gc, B);
    source.get('lexical-y').delete(1, 2);
    const cur = doc(333, gc, B);
    cur.get('lexical-y').delete(1, 1);
    const r = replayYRecovery(
      record(Y.encodeStateAsUpdate(source), 'g0'),
      B,
      Y.encodeStateAsUpdate(cur),
      config(gc, 'g0'),
    );
    expect(textOf(doc(9, gc, r.state).get('lexical-y'))).toBe('ad');
  });

  /** "abcdefgh" at layout 2 with a lone redundant {f:bold: null} before "d". */
  function redundantBase(): Uint8Array {
    const d = doc(100, gc);
    d.cleanupFormatting = false;
    const root = d.get('lexical-y');
    d.transact(() => {
      root.setAttr('lexical-y:2', true);
      root.insert(0, 'abcdefgh');
    });
    d.clientID = 101;
    d.transact(tr => {
      const at = Y.getItemCleanStart(tr, Y.createID(100, 3)) as Y.Item;
      const left = at.left as Y.Item;
      new Y.Item(
        Y.createID(101, d.store.getClock(101)),
        left,
        left.lastId,
        at,
        at.id,
        root,
        null,
        new Y.ContentFormat('f:bold', null as never),
      ).integrate(tr, 0);
    });
    return Y.encodeStateAsUpdate(d);
  }

  const bolds = (state: Uint8Array) =>
    plainRead(doc(9, gc, state).get('lexical-y'))
      .map(u => (u.values.get('f:bold') === true ? 'B' : '.'))
      .join('');

  test('a redundant format item of the same key inside the range does not cut the replayed run: applied once, in full', () => {
    const B = redundantBase();
    expect(bolds(B)).toBe('........');
    const rep = doc(222, gc, B);
    rep.get('lexical-y').format(1, 5, {'f:bold': true});
    const R = Y.encodeStateAsUpdate(rep);
    expect(bolds(R)).toBe('.BBBBB..');
    const rec = record(R, 'g0');
    const r1 = replayYRecovery(rec, B, B, config(gc, 'g0'));
    expect(r1.conflicts).toEqual([]);
    expect(r1.receipt.changes.filter(c => c.kind === 'format')).toMatchObject([
      {key: 'f:bold', length: 5, status: 'applied'},
    ]);
    expect(bolds(r1.state)).toBe('.BBBBB..');
    // A second replay with its ledger writes nothing.
    const r2 = replayYRecovery(
      rec,
      B,
      r1.state,
      config(gc, 'g0', {ledger: new Map(r1.receipt.ledger)}),
    );
    expect(r2.update).toBeNull();
    expect(r2.receipt.applied).toBe(0);
  });

  test('a format write that does not read back as intended is a conflict, never applied', () => {
    const B = redundantBase();
    const rep = doc(222, gc, B);
    rep.get('lexical-y').format(1, 5, {'f:bold': true});
    const rec = record(Y.encodeStateAsUpdate(rep), 'g0');
    // A codec for layout 2 whose write claims success and writes nothing.
    const broken: YReplayCodec = {
      read: container => plainRead(container),
      same: (_key, a, b) => JSON.stringify(a) === JSON.stringify(b),
      write: () => true,
    };
    const r = replayYRecovery(
      rec,
      B,
      B,
      config(gc, 'g0', {codecs: {2: broken}}),
    );
    expect(r.receipt.changes.filter(c => c.status === 'applied')).toEqual([]);
    expect(r.conflicts).toMatchObject([
      {key: 'f:bold', kind: 'format', reason: 'the write did not hold'},
    ]);
    // Nothing of the change shows (the update holds the record's own format
    // items only as deleted placeholders).
    expect(bolds(r.state)).toBe('........');
  });

  test('codecs: a root at a layout without a codec is not replayed; a codec given for the layout reads and writes its formats', () => {
    const base = doc(100, gc);
    const root = base.get('lexical-y');
    root.setAttr('lexical-y:2', true);
    root.insert(0, 'abc');
    const B = Y.encodeStateAsUpdate(base);
    const source = doc(222, gc, B);
    source.get('lexical-y').format(1, 1, {'f:bold': true});
    const rec = record(Y.encodeStateAsUpdate(source), 'g0');
    // The current document records layout 7.
    const cur = doc(300, gc, B);
    cur.get('lexical-y').setAttr('lexical-y:7', true);
    const C = Y.encodeStateAsUpdate(cur);
    const none = replayYRecovery(rec, B, C, config(gc, 'g0'));
    expect(none).toMatchObject({
      eligible: false,
      reason: 'layout 7 has no replay codec',
      update: null,
    });
    // A codec for layout 7 (here the plain one, counting its calls).
    const calls: string[] = [];
    const codec: YReplayCodec = {
      read: container => {
        calls.push('read');
        return plainRead(container);
      },
      same: (_key, a, b) => JSON.stringify(a) === JSON.stringify(b),
      write: (tr, container, before, next) => {
        calls.push(`write ${next.filter(v => v.has('f:bold')).length}`);
        return plainCodec.write(tr, container, before, next);
      },
    };
    const r = replayYRecovery(
      rec,
      B,
      C,
      config(gc, 'g0', {codecs: {7: codec}}),
    );
    expect(r.eligible).toBe(true);
    // Read, write, and the read that checks the write.
    expect(calls).toEqual(['read', 'write 1', 'read']);
    expect(
      plainRead(doc(9, gc, r.state).get('lexical-y')).map(
        u => u.values.get('f:bold') ?? null,
      ),
    ).toEqual([null, true, null]);
  });

  test('ledger: a source item an earlier replay inserted, deleted by the source since, is deleted', () => {
    const base = doc(100, gc);
    base.get('lexical-y').setAttr('lexical-y:2', true);
    base.get('lexical-y').insert(0, 'a');
    const B = Y.encodeStateAsUpdate(base);
    const source = doc(222, gc, B);
    source.get('lexical-y').insert(1, 'X');
    const first = replayYRecovery(
      record(Y.encodeStateAsUpdate(source), 'g0'),
      B,
      B,
      config(gc, 'g0'),
    );
    expect(textOf(doc(9, gc, first.state).get('lexical-y'))).toBe('aX');
    source.get('lexical-y').delete(1, 1);
    const ledger = new Map(
      first.receipt.ledger.map(([k, v]) => [k, v] as [string, string]),
    );
    const second = replayYRecovery(
      record(Y.encodeStateAsUpdate(source), 'g0'),
      B,
      first.state,
      config(gc, 'g0', {ledger}),
    );
    expect(textOf(doc(9, gc, second.state).get('lexical-y'))).toBe('a');
    expect(
      second.receipt.changes.some(
        c => c.kind === 'delete' && c.status === 'applied',
      ),
    ).toBe(true);
  });

  test('ledger: a conflict outcome is decided again on a later replay', () => {
    const base = doc(100, gc);
    base.get('lexical-y').setAttr('lexical-y:2', true);
    base.get('lexical-y').insert(0, 'a');
    const B = Y.encodeStateAsUpdate(base);
    const source = doc(222, gc, B);
    source.get('lexical-y').insert(1, 'X');
    const ledger = new Map([
      [`${INC}|g0|lexical-y|insert|222:0`, 'conflict|0:0:1'],
    ]);
    const r = replayYRecovery(
      record(Y.encodeStateAsUpdate(source), 'g0'),
      B,
      B,
      config(gc, 'g0', {ledger}),
    );
    expect(textOf(doc(9, gc, r.state).get('lexical-y'))).toBe('aX');
  });

  test('ledger: an entry of one source generation never skips the same id in another', () => {
    const base = doc(100, gc);
    base.get('lexical-y').setAttr('lexical-y:2', true);
    base.get('lexical-y').insert(0, 'a');
    const B = Y.encodeStateAsUpdate(base);
    const source = doc(222, gc, B);
    source.get('lexical-y').insert(1, 'X');
    const first = replayYRecovery(
      record(Y.encodeStateAsUpdate(source), 'g0'),
      B,
      B,
      config(gc, 'g0'),
    );
    const ledger = new Map(
      first.receipt.ledger.map(([k, v]) => [k, v] as [string, string]),
    );
    // A later generation: a new replica reusing client 222 from clock 0.
    const G3 = first.state;
    const fresh = doc(222, gc, G3);
    expect(fresh.store.clients.has(222)).toBe(false);
    fresh.get('lexical-y').insert(2, 'N');
    const r = replayYRecovery(
      record(Y.encodeStateAsUpdate(fresh), 'g3'),
      G3,
      G3,
      config(gc, 'g3', {ledger}),
    );
    expect(textOf(doc(9, gc, r.state).get('lexical-y'))).toBe('aXN');
  });

  test('a sparse base (a skipped range): an item the base holds is not inserted again', () => {
    const initial = doc(100, gc);
    initial.get('lexical-y').setAttr('lexical-y:2', true);
    initial.get('lexical-y').insert(0, 'base');
    const S = Y.encodeStateAsUpdate(initial);
    const source = doc(222, gc, S);
    const updates: Uint8Array[] = [];
    source.on('update', (u: Uint8Array) => updates.push(u));
    source.get('other').insert(0, 'MISSING');
    source.get('lexical-y').insert(4, 'LATE');
    const sparse = doc(300, gc, S);
    Y.applyUpdate(sparse, updates[1]);
    expect(sparse.store.skips.isEmpty()).toBe(false);
    const base = Y.encodeStateAsUpdate(sparse);
    const r = replayYRecovery(
      record(Y.encodeStateAsUpdate(source), 'g0'),
      base,
      base,
      config(gc, 'g0'),
    );
    expect(textOf(doc(9, gc, r.state).get('lexical-y'))).toBe('baseLATE');
    // The other top-level type is not served: not replayed.
    expect(doc(9, gc, r.state).get('other').length).toBe(0);
  });

  test("a sparse base: items in its skipped range are the record's inserts (a state-vector threshold misses them)", () => {
    const initial = doc(100, gc);
    initial.get('lexical-y').setAttr('lexical-y:2', true);
    initial.get('lexical-y').insert(0, 'one two');
    const S = Y.encodeStateAsUpdate(initial);
    const source = doc(222, gc, S);
    const updates: Uint8Array[] = [];
    source.on('update', (u: Uint8Array) => updates.push(u));
    source.get('lexical-y').insert(3, 'MID');
    source.get('lexical-y').insert(10, 'END');
    // The authority got the second update first (its origins are base
    // items): it holds END, with MID's clocks a skipped range.
    const sparse = doc(300, gc, S);
    Y.applyUpdate(sparse, updates[1]);
    expect(sparse.store.skips.isEmpty()).toBe(false);
    const base = Y.encodeStateAsUpdate(sparse);
    const src = Y.encodeStateAsUpdate(source);
    const r = replayYRecovery(record(src, 'g0'), base, base, config(gc, 'g0'));
    expect(textOf(doc(9, gc, r.state).get('lexical-y'))).toBe(
      textOf(source.get('lexical-y')),
    );
  });

  test.each([
    ['live in the base: exact, applied', false],
    ['deleted in the base: unknown, a conflict', true],
  ] as const)(
    'a format change whose base item is %s',
    (_label, baseDeletes) => {
      const initial = doc(100, gc);
      const root = initial.get('lexical-y');
      root.setAttr('lexical-y:2', true);
      root.insert(0, 'abc');
      // f:bold on "b": an opener before it and a closer after it.
      const fmt = (d: Y.Doc, at: number, value: unknown) =>
        d.transact(tr => {
          const r = d.get('lexical-y');
          let left: Y.Item | null = null;
          let n = 0;
          for (let it = r._start; it !== null; it = it.right) {
            if (!it.deleted && it.countable) {
              if (n + it.length > at) {
                if (at > n) {
                  Y.getItemCleanStart(
                    tr,
                    Y.createID(it.id.client, it.id.clock + (at - n)),
                  );
                  left = r._start;
                  for (let x = r._start; x !== null; x = x.right) {
                    if (
                      x.id.client === it.id.client &&
                      x.id.clock + x.length === it.id.clock + (at - n)
                    ) {
                      left = x;
                    }
                  }
                } else {
                  left = it.left;
                }
                break;
              }
              n += it.length;
            }
            left = it;
          }
          const right = left === null ? r._start : left.right;
          const item = new Y.Item(
            Y.createID(d.clientID, d.store.getClock(d.clientID)),
            left,
            left === null ? null : left.lastId,
            right,
            right === null ? null : right.id,
            r,
            null,
            new Y.ContentFormat('f:bold', value as never),
          );
          item.integrate(tr, 0);
          return item.id;
        });
      const opener = fmt(initial, 1, true);
      fmt(initial, 2, null);
      const S = Y.encodeStateAsUpdate(initial);
      const authority = doc(333, gc, S);
      if (baseDeletes) {
        authority.transact(tr =>
          (authority.store.getItem(opener) as unknown as Y.Item).delete(tr),
        );
      }
      const base = Y.encodeStateAsUpdate(authority);
      // The replica (which never saw that deletion) makes "b" 'x'.
      const source = doc(222, gc, S);
      fmt(source, 1, 'x');
      expect(
        plainRead(source.get('lexical-y')).map(
          u => u.values.get('f:bold') ?? null,
        ),
      ).toEqual([null, 'x', null]);
      const r = replayYRecovery(
        record(Y.encodeStateAsUpdate(source), 'g0'),
        base,
        base,
        config(gc, 'g0'),
      );
      const after = plainRead(doc(9, gc, r.state).get('lexical-y')).map(
        u => u.values.get('f:bold') ?? null,
      );
      if (baseDeletes) {
        expect(r.conflicts.map(c => [c.kind, c.reason])).toEqual([
          ['format', 'base value unknown'],
        ]);
        expect(after).toEqual([null, null, null]);
      } else {
        expect(r.conflicts).toEqual([]);
        expect(after).toEqual([null, 'x', null]);
      }
    },
  );

  test("split material (2.3): the pending record's items come back, once, though the base holds them", () => {
    const initial = doc(100, gc);
    initial.get('lexical-y').setAttr('lexical-y:2', true);
    initial.get('lexical-y').insert(0, 'base');
    const S0 = Y.encodeStateAsUpdate(initial);
    const source = doc(222, gc, S0);
    const updates: Uint8Array[] = [];
    source.on('update', (u: Uint8Array) => updates.push(u));
    source.get('other').insert(0, 'MISSING');
    source.get('lexical-y').insert(4, 'LATE');
    // The stored state integrated LATE past the gap; the migration split
    // it out (everything at or after the first missing clock): the current
    // document lacks it, the pending record holds it.
    const sparse = doc(300, gc, S0);
    Y.applyUpdate(sparse, updates[1]);
    const S = Y.encodeStateAsUpdate(sparse);
    const current = doc(301, gc, S0);
    current.get('lexical-y').setAttr('lexical-y:2', true);
    const C = Y.encodeStateAsUpdate(current);
    const pending = quarantineRecord({
      deltas: [updates[1]],
      kind: 'pending',
      receivedAt: 0,
      snapshot: null,
      source: {
        generation: 'g0',
        incarnation: INC,
        layouts: [1, 2],
        renderer: null,
        schemaVersion: 1,
      },
    });
    const r = replayYRecovery(pending, S, C, config(gc, 'g0'));
    expect(textOf(doc(9, gc, r.state).get('lexical-y'))).toBe('baseLATE');
    // A replica's record holding the same items: applied once.
    const ledger = new Map(
      r.receipt.ledger.map(([k, v]) => [k, v] as [string, string]),
    );
    const r2 = replayYRecovery(
      record(Y.encodeStateAsUpdate(source), 'g0'),
      S,
      r.state,
      config(gc, 'g0', {ledger}),
    );
    expect(textOf(doc(9, gc, r2.state).get('lexical-y'))).toBe('baseLATE');
  });

  test.each([
    ['declares peers', true],
    ['does not say (peers by default)', undefined],
  ] as const)(
    "base-proof: a replica that %s and got a peer's deletion before its write: a conflict, the current value kept",
    (_l, peers) => {
      const initial = doc(100, gc);
      const r = initial.get('lexical-y');
      r.setAttr('lexical-y:2', true);
      const n = new Y.Node('b:caption');
      r.insert(0, [n]);
      n.setAttr('p:caption', 'RED_TEXT');
      const S = Y.encodeStateAsUpdate(initial);
      const sv = Y.encodeStateVector(initial);
      const field = (d: Y.Doc) =>
        (d.get('lexical-y')._start!.content as Y.ContentType).type as Y.Node;
      const p1 = doc(222, gc, S);
      field(p1).deleteAttr('p:caption');
      const p2 = doc(333, gc, S);
      // A same-generation peer channel delivers P1's deletion first.
      Y.applyUpdate(p2, Y.encodeStateAsUpdate(p1, sv));
      field(p2).setAttr('p:caption', 'BLUE_TEXT');
      const current = doc(400, gc, S);
      field(current).deleteAttr('p:caption');
      current.clientID = 500;
      field(current).setAttr('p:caption', 'RED_TEXT');
      const rec = {
        ...makeRecord({
          kind: 'handoff',
          receivedAt: 0,
          snapshot: Y.encodeStateAsUpdate(p2),
          source: {
            generation: 'g0',
            incarnation: INC,
            layouts: [1, 2],
            renderer: null,
            schemaVersion: 1,
          },
        }),
        ...(peers === undefined ? {} : {peers}),
      };
      const out = replayYRecovery(
        rec,
        S,
        Y.encodeStateAsUpdate(current),
        config(gc, 'g0'),
      );
      expect(out.conflicts.map(c => [c.kind, c.key, c.reason])).toEqual([
        ['attribute', 'p:caption', 'the replica had peers'],
      ]);
      expect(field(doc(9, gc, out.state)).getAttr('p:caption')).toBe(
        'RED_TEXT',
      );
    },
  );

  test('base-proof: a peer-free replica that wrote an attribute twice reaches the base through its own entries', () => {
    const initial = doc(100, gc);
    const r = initial.get('lexical-y');
    r.setAttr('lexical-y:2', true);
    const n = new Y.Node('b:caption');
    r.insert(0, [n]);
    n.setAttr('p:caption', 'RED_TEXT');
    const S = Y.encodeStateAsUpdate(initial);
    const field = (d: Y.Doc) =>
      (d.get('lexical-y')._start!.content as Y.ContentType).type as Y.Node;
    const source = doc(222, gc, S);
    field(source).setAttr('p:caption', 'GREEN_TEXT');
    field(source).setAttr('p:caption', 'BLUE_TEXT');
    const out = replayYRecovery(
      record(Y.encodeStateAsUpdate(source), 'g0'),
      S,
      S,
      config(gc, 'g0'),
    );
    expect(out.conflicts).toEqual([]);
    expect(field(doc(9, gc, out.state)).getAttr('p:caption')).toBe('BLUE_TEXT');
  });

  test.each([
    ['its first write by another client', 'first'],
    ["a chain through another client's entry", 'chain'],
  ] as const)(
    'base-proof (r5): an attribute change on %s is not proved: a conflict',
    (_l, how) => {
      const initial = doc(100, gc);
      const r = initial.get('lexical-y');
      r.setAttr('lexical-y:2', true);
      const n = new Y.Node('b:caption');
      r.insert(0, [n]);
      n.setAttr('p:caption', 'RED_TEXT');
      const S = Y.encodeStateAsUpdate(initial);
      const field = (d: Y.Doc) =>
        (d.get('lexical-y')._start!.content as Y.ContentType).type as Y.Node;
      // A writer sharing nothing with the replica's recorded clients (a peer,
      // or a client id the replica did not record) wrote GREEN; the replica
      // (222) then wrote BLUE over it, or the stranger wrote last.
      const stranger = doc(555, gc, S);
      field(stranger).setAttr('p:caption', 'GREEN_TEXT');
      const source = doc(222, gc, Y.encodeStateAsUpdate(stranger));
      if (how === 'chain') {
        field(source).setAttr('p:caption', 'BLUE_TEXT');
      }
      const rec = makeRecord({
        clients: [222],
        kind: 'handoff',
        peers: false,
        receivedAt: 0,
        snapshot: Y.encodeStateAsUpdate(source),
        source: {
          generation: 'g0',
          incarnation: INC,
          layouts: [1, 2],
          renderer: null,
          schemaVersion: 1,
        },
      });
      const out = replayYRecovery(rec, S, S, config(gc, 'g0'));
      expect(out.conflicts.map(c => [c.kind, c.key, c.reason])).toEqual([
        [
          'attribute',
          'p:caption',
          how === 'chain' ? 'base value unknown' : 'not written by the replica',
        ],
      ]);
      expect(field(doc(9, gc, out.state)).getAttr('p:caption')).toBe(
        'RED_TEXT',
      );
    },
  );

  test('base-proof (r5): a format run set by a client the replica did not record is not proved: a conflict', () => {
    const initial = doc(100, gc);
    const root = initial.get('lexical-y');
    root.setAttr('lexical-y:2', true);
    root.insert(0, 'abc');
    const S = Y.encodeStateAsUpdate(initial);
    const stranger = doc(555, gc, S);
    stranger.get('lexical-y').format(1, 1, {'f:bold': 'x'});
    const source = doc(222, gc, Y.encodeStateAsUpdate(stranger));
    source.get('lexical-y').format(1, 1, {'f:bold': 'y'});
    const rec = makeRecord({
      clients: [222],
      kind: 'handoff',
      peers: false,
      receivedAt: 0,
      snapshot: Y.encodeStateAsUpdate(source),
      source: {
        generation: 'g0',
        incarnation: INC,
        layouts: [1, 2],
        renderer: null,
        schemaVersion: 1,
      },
    });
    const out = replayYRecovery(rec, S, S, config(gc, 'g0'));
    expect(out.conflicts.map(c => [c.kind, c.key, c.reason])).toEqual([
      ['format', 'f:bold', 'base value unknown'],
    ]);
  });

  test('a pending record built by pendingYRecord (the whole stored state and its cut bytes) brings the cut items back once', () => {
    const initial = doc(100, gc);
    initial.get('lexical-y').setAttr('lexical-y:2', true);
    initial.get('lexical-y').insert(0, 'base');
    const S0 = Y.encodeStateAsUpdate(initial);
    const source = doc(222, gc, S0);
    const updates: Uint8Array[] = [];
    source.on('update', (u: Uint8Array) => updates.push(u));
    source.get('other').insert(0, 'MISSING');
    source.get('lexical-y').insert(4, 'LATE');
    const sparse = doc(300, gc, S0);
    Y.applyUpdate(sparse, updates[1]);
    const stored = Y.encodeStateAsUpdate(sparse);
    const C = Y.encodeStateAsUpdate(doc(301, gc, S0));
    const rec = pendingYRecord({
      pending: updates[1],
      receivedAt: 0,
      source: {
        generation: 'g0',
        incarnation: INC,
        layouts: [1, 2],
        renderer: null,
        schemaVersion: 1,
      },
      stored,
    });
    const r = replayYRecovery(rec, stored, C, config(gc, 'g0'));
    expect(textOf(doc(9, gc, r.state).get('lexical-y'))).toBe('baseLATE');
    const ledger = new Map(
      r.receipt.ledger.map(([k, v]) => [k, v] as [string, string]),
    );
    const again = replayYRecovery(
      rec,
      stored,
      r.state,
      config(gc, 'g0', {ledger}),
    );
    expect(textOf(doc(9, gc, again.state).get('lexical-y'))).toBe('baseLATE');
  });

  test('split (r4): a pending record is read on its base, so an item cut for its right origin comes back in place', () => {
    const base = doc(100, gc);
    const root = base.get('lexical-y');
    root.setAttr('lexical-y:2', true);
    root.insert(0, 'base');
    const S = Y.encodeStateAsUpdate(base);
    const c = doc(222, gc, S);
    const cu: Uint8Array[] = [];
    c.on('update', (u: Uint8Array) => cu.push(u));
    c.get('unseen').insert(0, 'missing');
    c.get('lexical-y').insert(4, 'LATE');
    const before = doc(300, gc, S);
    Y.applyUpdate(before, cu[1]);
    const d = doc(333, gc, Y.encodeStateAsUpdate(before));
    const du: Uint8Array[] = [];
    d.on('update', (u: Uint8Array) => du.push(u));
    d.get('lexical-y').insert(4, 'G');
    for (const u of du) {
      Y.applyUpdate(before, u);
    }
    const B = Y.encodeStateAsUpdate(before);
    // The split cut LATE (past the gap) and G (right origin LATE): the
    // migrated document keeps only "base".
    const current = doc(301, gc, S);
    const C = Y.encodeStateAsUpdate(current);
    const pending = quarantineRecord({
      deltas: [cu[1], ...du],
      kind: 'pending',
      receivedAt: 0,
      snapshot: null,
      source: {
        generation: 'g0',
        incarnation: INC,
        layouts: [1, 2],
        renderer: null,
        schemaVersion: 1,
      },
    });
    const out = replayYRecovery(pending, B, C, config(gc, 'g0'));
    expect(textOf(doc(9, gc, out.state).get('lexical-y'))).toBe(
      textOf(before.get('lexical-y')),
    );
    expect(textOf(before.get('lexical-y'))).toBe('baseGLATE');
  });

  test('a deletion the view holds only in its delete set (the item in its skipped range) is applied', () => {
    const initial = doc(100, gc);
    initial.get('lexical-y').setAttr('lexical-y:2', true);
    initial.get('lexical-y').insert(0, 'base');
    const S0 = Y.encodeStateAsUpdate(initial);
    const c = doc(222, gc, S0);
    const cu: Uint8Array[] = [];
    c.on('update', (u: Uint8Array) => cu.push(u));
    c.get('lexical-y').insert(4, 'XY');
    c.get('lexical-y').insert(0, 'Z');
    const full = doc(300, gc, S0);
    Y.applyUpdate(full, cu[0]);
    Y.applyUpdate(full, cu[1]);
    const B = Y.encodeStateAsUpdate(full);
    const d = doc(333, gc, B);
    const du: Uint8Array[] = [];
    d.on('update', (u: Uint8Array) => du.push(u));
    d.get('lexical-y').delete(5, 1);
    // The replica got Z (past a gap: XY skipped) and the deletion of X.
    const replica = doc(444, gc, S0);
    Y.applyUpdate(replica, cu[1]);
    Y.applyUpdate(replica, du[0]);
    expect(replica.store.skips.isEmpty()).toBe(false);
    const r = replayYRecovery(
      record(Y.encodeStateAsUpdate(replica), 'g0'),
      B,
      B,
      config(gc, 'g0'),
    );
    expect(textOf(doc(9, gc, r.state).get('lexical-y'))).toBe('ZbaseY');
  });

  test('the signal transcript: only an item matching id, parent, key and content is ignored', () => {
    const base = doc(100, gc);
    const root = base.get('lexical-y');
    root.setAttr('lexical-y:1', true);
    root.setAttr('lexical-y-schema:1', true);
    root.insert(0, 'base');
    const S = Y.encodeStateAsUpdate(base);
    // The tab's client 942 had written nothing when it was captured; the
    // signal took 942:0; the tab then typed X as 942:0.
    const source = doc(942, gc, S);
    const snapshot = Y.encodeStateAsUpdate(source);
    const signalDoc = doc(942, gc, snapshot);
    signalDoc.get('lexical-y').setAttr('lexical-y-schema:2', true);
    const signalItem = {
      client: 942,
      clock: 0,
      key: 'lexical-y-schema:2',
      root: 'lexical-y',
      update: Y.encodeStateAsUpdate(signalDoc, Y.encodeStateVector(base)),
    };
    const vector = Y.encodeStateVector(source);
    source.get('lexical-y').insert(4, 'X');
    const delta = Y.encodeStateAsUpdate(source, vector);
    const raced = quarantineRecord({
      deltas: [delta],
      kind: 'capture',
      receivedAt: 0,
      signals: [signalItem],
      snapshot,
      source: {
        generation: 'g0',
        incarnation: INC,
        layouts: [1, 2],
        renderer: null,
        schemaVersion: 1,
      },
    });
    const r = replayYRecovery(raced, S, S, config(gc, 'g0'));
    expect(textOf(doc(9, gc, r.state).get('lexical-y'))).toBe('baseX');
    // A view holding the signal itself: ignored, never written to the room.
    const withSignal = quarantineRecord({
      deltas: [Y.encodeStateAsUpdate(signalDoc, Y.encodeStateVector(base))],
      kind: 'capture',
      receivedAt: 0,
      signals: [signalItem],
      snapshot,
      source: {
        generation: 'g0',
        incarnation: INC,
        layouts: [1, 2],
        renderer: null,
        schemaVersion: 1,
      },
    });
    const r2 = replayYRecovery(withSignal, S, S, config(gc, 'g0'));
    expect(
      doc(9, gc, r2.state).get('lexical-y').getAttr('lexical-y-schema:2'),
    ).toBeUndefined();
  });

  test('a container the source deleted goes with what the current document typed into it (D49, as an unfenced merge)', () => {
    const b = doc(100, gc);
    b.get('lexical-y').setAttr('lexical-y:2', true);
    const nested = new Y.Node('b:box');
    b.get('lexical-y').insert(0, [nested]);
    nested.insert(0, 'base');
    const S = Y.encodeStateAsUpdate(b);
    const source = doc(222, gc, S);
    source.get('lexical-y').delete(0, 1);
    const cur = doc(333, gc, S);
    (
      (cur.get('lexical-y')._start!.content as Y.ContentType).type as Y.Node
    ).insert(4, 'ONLINE');
    const current = Y.encodeStateAsUpdate(cur);
    const r = replayYRecovery(
      record(Y.encodeStateAsUpdate(source), 'g0'),
      S,
      current,
      config(gc, 'g0'),
    );
    const control = doc(444, gc, current);
    Y.applyUpdate(
      control,
      Y.encodeStateAsUpdate(source, Y.encodeStateVectorFromUpdate(S)),
    );
    expect(textOf(doc(9, gc, r.state).get('lexical-y'))).toBe(
      textOf(control.get('lexical-y')),
    );
    expect(textOf(doc(9, gc, r.state).get('lexical-y'))).toBe('');
  });
});
