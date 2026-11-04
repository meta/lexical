/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The layout 3 writer and reader for whole containers (internal/Layout3.ts):
// the pure reader follows the binding's grammar exactly
// (overlapping runs, orphan and malformed ends), every value is validated
// before anything is written, an array's holes encode as null, and the
// canonical form is the live writer's.
import * as Y from '@y/y';
import {$getRoot, $isTextNode, $setSelection} from 'lexical';
import {expect, test} from 'vitest';

import {Cursor} from '../../internal/Cursor';
import {covered, isShadowKey, stepFormat} from '../../internal/Ident';
import {
  isCoveredKey,
  readLayout3Formats,
  storedUnit,
  writeLayout3Formats,
} from '../../internal/Layout3';
import {$p, $selectIn, setup} from '../utils/harness';

const obj = (m: ReadonlyMap<string, unknown>) => Object.fromEntries(m);
function coreRead(root: Y.Node) {
  const m = new Map<string, unknown>();
  const out: Record<string, unknown>[] = [];
  for (let it = root._start; it; it = it.right) {
    if (it.deleted) continue;
    if (it.content instanceof Y.ContentFormat) stepFormat(m, it);
    else if (it.countable) {
      const v = Object.fromEntries(
        [...m].filter(([k]) => covered(k) && !isShadowKey(k)),
      );
      for (let n = 0; n < it.length; n++) out.push(v);
    }
  }
  return out;
}
function rawDoc(gc: boolean) {
  const doc = new Y.Doc({gc});
  doc.cleanupFormatting = false;
  doc.clientID = 7;
  doc.get('c').insert(0, 'abc');
  return doc;
}
function appendFormat(
  tr: Y.Transaction,
  root: Y.Node,
  left: Y.Item | null,
  key: string,
  value: unknown,
) {
  const right = left ? left.right : root._start;
  const it = new Y.Item(
    Y.createID(tr.doc.clientID, tr.doc.store.getClock(tr.doc.clientID)),
    left,
    left && left.lastId,
    right,
    right && right.id,
    root,
    null,
    new Y.ContentFormat(key, value as object),
  );
  it.integrate(tr, 0);
  return it;
}
function liveFormats(root: Y.Node) {
  const out: [string, unknown][] = [];
  for (let it = root._start; it; it = it.right) {
    if (!it.deleted && it.content instanceof Y.ContentFormat)
      out.push([it.content.key, it.content.value]);
  }
  return out;
}

for (const gc of [false, true]) {
  test(`overlapping binding-written style pairs: pure/core agreement gc=${gc}`, async () => {
    const t = await setup(() => $getRoot().append($p('abcd')), {
      delivery: 'sender',
      gc,
    });
    t.offline();
    t.a.update(() => {
      for (const n of $selectIn([0], 0, 2).extract())
        if ($isTextNode(n)) n.setStyle('color: red');
      $setSelection(null);
    });
    t.b.update(() => {
      for (const n of $selectIn([0], 1, 4).extract())
        if ($isTextNode(n)) n.setStyle('color: blue');
      $setSelection(null);
    });
    await t.sync();
    const root = t.a.doc.get('lexical-y');
    expect(readLayout3Formats(root).map(obj)).toEqual(coreRead(root));
  });
  test(`orphan and malformed ends: pure/core agreement gc=${gc}`, () => {
    const results: unknown[] = [];
    for (const value of [[9999], ['bad']]) {
      const doc = rawDoc(gc);
      const root = doc.get('c');
      doc.transact(tr => {
        appendFormat(tr, root, null, 'p:style', 'red');
        const a = Y.getItemCleanStart(tr, Y.createID(7, 1)).left!;
        appendFormat(tr, root, a, 'p:style', value);
      });
      results.push({
        core: coreRead(root),
        pure: readLayout3Formats(root).map(obj),
      });
    }
    for (const result of results as {pure: unknown; core: unknown}[])
      expect(result.pure).toEqual(result.core);
  });
  test(`the covered keys can be narrowed; by default they are isCoveredKey's gc=${gc}`, () => {
    const doc = rawDoc(gc);
    const root = doc.get('c');
    root.format(0, 3, {'f:italic': true});
    const bold = (key: string) => key === 'f:bold';
    doc.transact(tr =>
      writeLayout3Formats(
        tr,
        root,
        Array.from({length: 3}, () => new Map([['f:bold', true]])),
        bold,
      ),
    );
    // The italic items are not the narrowed writer's: they stay, and only
    // the default read shows them.
    expect(readLayout3Formats(root, bold).map(obj)).toEqual(
      Array.from({length: 3}, () => ({'f:bold': true})),
    );
    expect(readLayout3Formats(root).map(obj)).toEqual(
      Array.from({length: 3}, () => ({'f:bold': true, 'f:italic': true})),
    );
    expect(readLayout3Formats(root, isCoveredKey)).toEqual(
      readLayout3Formats(root),
    );
    expect(() => storedUnit(new Map([['f:italic', true]]), bold)).toThrow();
    expect(storedUnit(new Map([['f:italic', true]]))).toEqual(
      new Map([['f:italic', ['true', true]]]),
    );
  });
  test(`undefined refused before any write gc=${gc}`, () => {
    const doc = rawDoc(gc);
    const root = doc.get('c');
    root.format(0, 3, {'f:bold': true});
    const before = Y.encodeStateAsUpdate(doc);
    let thrown = false;
    const clock = doc.store.getClock(7);
    try {
      doc.transact(tr =>
        writeLayout3Formats(
          tr,
          root,
          Array.from({length: 3}, () => new Map([['p:meta', undefined]])),
        ),
      );
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(true);
    // Unchanged bytes and clock: nothing was written.
    expect(doc.store.getClock(7)).toBe(clock);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
  test(`values JSON cannot encode are refused before any write gc=${gc}`, () => {
    for (const bad of [
      () => 1,
      Symbol('s'),
      BigInt(1),
      Number.NaN,
      Infinity,
      null,
      (() => {
        const c: Record<string, unknown> = {};
        c.self = c;
        return c;
      })(),
    ]) {
      const doc = rawDoc(gc);
      const root = doc.get('c');
      root.format(0, 3, {'f:bold': true});
      const before = Y.encodeStateAsUpdate(doc);
      expect(() =>
        doc.transact(tr =>
          writeLayout3Formats(
            tr,
            root,
            Array.from(
              {length: 3},
              (_, i) => new Map([['p:meta', i === 2 ? bad : 'x']]),
            ),
          ),
        ),
      ).toThrow();
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    }
  });
  test(`sparse raw arrays roundtrip gc=${gc}`, () => {
    const doc = rawDoc(gc);
    const root = doc.get('c');
    const v = Array(2);
    doc.transact(tr =>
      writeLayout3Formats(
        tr,
        root,
        Array.from({length: 3}, () => new Map([['p:meta', v]])),
      ),
    );
    const encoded = readLayout3Formats(root)[0].get('p:meta') as {json: string};
    expect(JSON.parse(encoded.json)).toEqual([null, null]);
  });
  test(`all countable content and stored key classes roundtrip gc=${gc}`, () => {
    const doc = new Y.Doc({gc});
    doc.cleanupFormatting = false;
    doc.clientID = 7;
    const root = doc.get('c');
    const marker = new Y.Node('¶');
    const child = new Y.Node('b:quote');
    root.insert(0, 'a😀\n\t');
    root.insert(5, [marker, child, {embed: 1}, 42]);
    marker.setAttr('p:textFormat', 8);
    marker.setAttr('s:blockId', 'block');
    child.insert(0, 'nested');
    const attrs = marker.getAttrs();
    const nested = child._start;
    const fields = new Map<string, unknown>([
      ['f:bold', true],
      ['s:ids\u001fx', true],
      ['p:meta', {json: '{"a":1}'}],
      ['p:color', 'red'],
      ['w:link', {rel: null, target: null, title: null, url: 'x'}],
      ['t', 'custom'],
      ['k', 'segment'],
    ]);
    const values = Array.from({length: 9}, () => new Map(fields));
    doc.transact(tr => writeLayout3Formats(tr, root, values));
    expect(readLayout3Formats(root).map(obj)).toEqual(values.map(obj));
    expect(coreRead(root)).toEqual(values.map(obj));
    expect(marker.getAttrs()).toEqual(attrs);
    expect(child._start).toBe(nested);
  });
  test(`deterministic updates with reordered map keys gc=${gc}`, () => {
    const run = (reverse: boolean) => {
      const doc = rawDoc(gc);
      const root = doc.get('c');
      root.format(0, 2, {'f:bold': true});
      root.format(2, 1, {'s:flat': 'keep'});
      const sv = Y.encodeStateVector(doc);
      const entries: [string, unknown][] = [
        ['p:meta', [1, {a: 1, b: 2}]],
        ['w:link', {rel: null, url: 'x'}],
      ];
      if (reverse) entries.reverse();
      doc.transact(tr =>
        writeLayout3Formats(tr, root, [
          new Map(entries),
          new Map(entries),
          new Map(),
        ]),
      );
      return Y.encodeStateAsUpdate(doc, sv);
    };
    expect(run(false)).toEqual(run(true));
  });
  test(`canonical form: maximal equal-map segments, ends in the openers' (key) order gc=${gc}`, () => {
    // Settled canonical form (full-map, the live writer's): a segment is a
    // maximal run of units whose covered values are all equal; each opens
    // every key it has, in key order, and ends them in the same order.
    const doc = rawDoc(gc);
    const root = doc.get('c');
    const values = [
      new Map<string, unknown>([['f:bold', true]]),
      new Map<string, unknown>([
        ['f:bold', true],
        ['f:italic', true],
      ]),
      new Map<string, unknown>([['f:italic', true]]),
    ];
    doc.transact(tr => writeLayout3Formats(tr, root, values));
    expect(liveFormats(root)).toEqual([
      ['f:bold', true],
      ['f:bold', [1]],
      ['f:bold', true],
      ['f:italic', true],
      ['f:bold', [2]],
      ['f:italic', [2]],
      ['f:italic', true],
      ['f:italic', [1]],
    ]);
    expect(readLayout3Formats(root).map(obj)).toEqual(values.map(obj));
  });
  test(`one-shot live insert canonical order gc=${gc}`, () => {
    const doc = new Y.Doc({gc});
    doc.cleanupFormatting = false;
    doc.clientID = 7;
    const root = doc.get('c');
    root.setAttr('lexical-y:3', true);
    doc.transact(tr =>
      new Cursor(tr, root, null, new Map()).insert(new Y.ContentString('ab'), {
        'f:bold': true,
        'f:italic': true,
      }),
    );
    const live = liveFormats(root).map(([k, v]) => [
      k,
      Array.isArray(v) ? 'end' : v,
    ]);
    const other = new Y.Doc({gc});
    other.cleanupFormatting = false;
    other.clientID = 7;
    const target = other.get('c');
    target.setAttr('lexical-y:3', true);
    target.insert(0, 'ab');
    other.transact(tr =>
      writeLayout3Formats(tr, target, [
        new Map([
          ['f:bold', true],
          ['f:italic', true],
        ]),
        new Map([
          ['f:bold', true],
          ['f:italic', true],
        ]),
      ]),
    );
    const pure = liveFormats(target).map(([k, v]) => [
      k,
      Array.isArray(v) ? 'end' : v,
    ]);
    // The live writer keeps its own (full-map) order for typed text, which
    // is not canonical: the same items in another order, the same read.
    expect([...pure].sort()).toEqual([...live].sort());
    expect(readLayout3Formats(target).map(obj)).toEqual(
      readLayout3Formats(root).map(obj),
    );
  });
  test(`live consecutive inserts compared with whole-container canonical gc=${gc}`, () => {
    const doc = new Y.Doc({gc});
    doc.cleanupFormatting = false;
    doc.clientID = 7;
    const root = doc.get('c');
    root.setAttr('lexical-y:3', true);
    doc.transact(tr => {
      const c = new Cursor(tr, root, null, new Map());
      c.insert(new Y.ContentString('a'), {'f:bold': true});
      c.insert(new Y.ContentString('b'), {'f:bold': true, 'f:italic': true});
      c.insert(new Y.ContentString('c'), {});
    });
    const before = liveFormats(root).map(([k, v]) => [
      k,
      Array.isArray(v) ? 'end' : v,
    ]);
    const values = readLayout3Formats(root);
    doc.transact(tr => writeLayout3Formats(tr, root, values));
    const after = liveFormats(root).map(([k, v]) => [
      k,
      Array.isArray(v) ? 'end' : v,
    ]);
    // Rewritten canonical: the live writer's own form, the same read.
    expect(after).toEqual(before);
    expect(readLayout3Formats(root).map(obj)).toEqual(values.map(obj));
  });
}
