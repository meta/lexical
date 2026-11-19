/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The 2to3 step's frozen copy of the layout 3 writer
// (migrate/2to3/frozen/layout3.ts) passes the live writer's pinned cells
// (Layout4.test.ts, of the 3to4 step's copy): the covered-key predicate is
// layout 3's (the binding's but for flat NodeState, which layout 4 covers), it
// reproduces the values read by its own fold and the binding's, it writes
// the golden bytes, a second call gives the same layout, and it refuses bad
// input before writing.

import * as Y from '@y/y';
import {describe, expect, test} from 'vitest';

import {
  covered,
  isShadowKey,
  stepFormat,
  STORED_FOLD,
} from '../../internal/Ident';
import {
  isCoveredKey,
  readLayout3Formats,
  writeLayout3Formats,
} from '../../migrate/2to3/frozen/layout3';

/** A container: "ab" + marker + "cd\te" + marker, plus an uncovered item. */
function makeDoc(clientID: number): Y.Doc {
  const doc = new Y.Doc({gc: false});
  doc.clientID = clientID;
  doc.cleanupFormatting = false;
  const root = doc.get('c');
  doc.transact(() => {
    root.insert(0, 'ab');
    root.insert(2, [new Y.Node('¶')]);
    root.insert(3, 'cd\te');
    root.insert(7, [new Y.Node('¶')]);
    // An uncovered flat NodeState key and a legacy covered run.
    root.format(0, 1, {'s:flat': 'x'});
    root.format(3, 2, {'f:bold': true});
  });
  return doc;
}

/**
 * Golden layout and bytes of VALUES written into makeDoc(7), in the
 * canonical (full-map) form: a frozen copy of the writer must give exactly
 * these.
 */
const GOLDEN_LAYOUT = `{f:bold=true} {s:flat="x"} a {f:bold=[1]} {f:bold=true} {f:italic=true} {s:flat=null} b {f:bold=[2]} {f:italic=[2]} [¶] {s:markIdsc1=true} {w:link={"rel":null,"target":null,"title":null,"url":"https://x.test"}} cd {s:markIdsc1=[2]} {w:link=[2]} {k="seg1"} {t="tab"} 	 {k=[2]} {t=[2]} {p:meta={"json":"[1,2]"}} e {p:meta=[1]} [¶]`;
const GOLDEN_BYTES = `ARAHDEYHCAZmOmJvbGQEdHJ1ZcYHAAcJBmY6Ym9sZANbMV3GBw0HCQZmOmJvbGQEdHJ1ZcYHDgcJCGY6aXRhbGljBHRydWXGBwEHAgZmOmJvbGQDWzJdxgcQBwIIZjppdGFsaWMDWzJdxgcCBwoMczptYXJrSWRzH2MxBHRydWXGBxIHCgZ3Omxpbms+eyJyZWwiOm51bGwsInRhcmdldCI6bnVsbCwidGl0bGUiOm51bGwsInVybCI6Imh0dHBzOi8veC50ZXN0In3GBwQHCwxzOm1hcmtJZHMfYzEDWzJdxgcUBwsGdzpsaW5rA1syXcYHFQcLAWsGInNlZzEixgcWBwsBdAUidGFiIsYHBQcGAWsDWzJdxgcYBwYBdANbMl3GBxkHBgZwOm1ldGEQeyJqc29uIjoiWzEsMl0ifcYHBgcHBnA6bWV0YQNbMV0BBwEKAg==`;

const LINK = {rel: null, target: null, title: null, url: 'https://x.test'};
/** Values per countable unit: a b ¶ c d \t e ¶. */
const VALUES: Map<string, unknown>[] = [
  new Map<string, unknown>([['f:bold', true]]),
  new Map<string, unknown>([
    ['f:bold', true],
    ['f:italic', true],
  ]),
  new Map(),
  new Map<string, unknown>([
    ['s:markIds\u001fc1', true],
    ['w:link', LINK],
  ]),
  new Map<string, unknown>([
    ['s:markIds\u001fc1', true],
    ['w:link', LINK],
  ]),
  new Map<string, unknown>([
    ['k', 'seg1'],
    ['t', 'tab'],
  ]),
  new Map<string, unknown>([['p:meta', [1, 2]]]),
  new Map(),
];

const toObj = (m: ReadonlyMap<string, unknown>) =>
  Object.fromEntries([...m].sort(([a], [b]) => (a < b ? -1 : 1)));
const expected = VALUES.map(m =>
  toObj(
    new Map(
      [...m].map(([k, v]) => [
        k,
        Array.isArray(v) ? {json: JSON.stringify(v)} : v,
      ]),
    ),
  ),
);

/** The binding's fold (Ident) per countable unit, covered keys only. */
function coreRead(container: Y.Node): Record<string, unknown>[] {
  const formats = new Map<string, unknown>();
  const out: Record<string, unknown>[] = [];
  for (
    let it = container._start as Y.Item | null;
    it !== null;
    it = it.right as Y.Item | null
  ) {
    if (it.deleted) {
      continue;
    }
    if (it.content instanceof Y.ContentFormat) {
      stepFormat(formats, it, STORED_FOLD);
    } else if (it.countable) {
      const m = new Map<string, unknown>();
      for (const [k, v] of formats) {
        if (
          !isShadowKey(k) &&
          isCoveredKey(k) &&
          v !== null &&
          !(Array.isArray(v) && v.length === 0)
        ) {
          m.set(k, v);
        }
      }
      for (let i = 0; i < it.length; i++) {
        out.push(toObj(m));
      }
    }
  }
  return out;
}

const layout = (container: Y.Node) => {
  const out: string[] = [];
  for (
    let it = container._start as Y.Item | null;
    it !== null;
    it = it.right as Y.Item | null
  ) {
    if (!it.deleted) {
      const c = it.content as unknown as {
        str?: string;
        key?: string;
        value?: unknown;
        type?: {name: string};
      };
      out.push(
        c.str !== undefined
          ? c.str
          : c.key !== undefined
            ? `{${c.key}=${JSON.stringify(c.value)}}`
            : `[${c.type!.name}]`,
      );
    }
  }
  return out.join(' ');
};

describe('the frozen writeLayout3Formats (2to3)', () => {
  test('the covered-key predicate is layout 3’s: the binding’s, but for flat NodeState', () => {
    for (const key of [
      't',
      'k',
      'c',
      'f:bold',
      'p:style',
      'w:link',
      's:flat',
      's:markIds\u001fc1',
      'x:y',
      'lexical-y:3',
    ]) {
      // Layout 4 covers flat NodeState too (D120); layout 3 did not.
      expect(isCoveredKey(key), key).toBe(
        key === 's:flat' ? false : covered(key),
      );
    }
    expect(covered('s:flat')).toBe(true);
  });

  test('reproduces the values, read by its own fold and by the binding’s', () => {
    const doc = makeDoc(7);
    const root = doc.get('c');
    let result = {deleted: 0, written: 0};
    doc.transact(tr => {
      result = writeLayout3Formats(tr, root, VALUES);
    });
    // The legacy bold run (opener and null) is deleted; the flat key stays.
    expect(result.deleted).toBe(2);
    expect(layout(root)).toContain('{s:flat="x"}');
    expect(readLayout3Formats(root).map(toObj)).toEqual(expected);
    expect(coreRead(root)).toEqual(expected);
    expect(layout(root)).toBe(GOLDEN_LAYOUT);
  });

  test('deterministic: the same items, values, client id and clock give the same bytes', () => {
    const run = () => {
      const doc = makeDoc(7);
      const before = Y.encodeStateVector(doc);
      doc.transact(tr => writeLayout3Formats(tr, doc.get('c'), VALUES));
      return Y.encodeStateAsUpdate(doc, before);
    };
    const bytes = Buffer.from(run()).toString('base64');
    expect(Buffer.from(run()).toString('base64')).toBe(bytes);
    // Golden: a frozen copy of the writer must give exactly these bytes.
    expect(bytes).toBe(GOLDEN_BYTES);
  });

  test('a second call gives the same read and the same canonical layout', () => {
    const doc = makeDoc(7);
    const root = doc.get('c');
    doc.transact(tr => writeLayout3Formats(tr, root, VALUES));
    const first = layout(root);
    doc.transact(tr => writeLayout3Formats(tr, root, VALUES));
    expect(layout(root)).toBe(first);
    expect(readLayout3Formats(root).map(toObj)).toEqual(expected);
  });

  test('refuses, before writing, a length mismatch, an uncovered key, a value JSON cannot encode, another document', () => {
    const doc = makeDoc(7);
    const root = doc.get('c');
    const other = makeDoc(8);
    const sv = Y.encodeStateVector(doc);
    const bad: Map<string, unknown>[][] = [
      VALUES.slice(1),
      VALUES.map((m, i) =>
        i === 0 ? new Map<string, unknown>([['s:flat', 'x']]) : m,
      ),
      VALUES.map((m, i) =>
        i === 0 ? new Map<string, unknown>([['f:bold', BigInt(1)]]) : m,
      ),
    ];
    for (const values of bad) {
      expect(() =>
        doc.transact(tr => writeLayout3Formats(tr, root, values)),
      ).toThrow();
    }
    expect(() =>
      other.transact(tr => writeLayout3Formats(tr, root, VALUES)),
    ).toThrow();
    expect(Y.encodeStateVector(doc)).toEqual(sv);
  });
});
