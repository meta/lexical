/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The runner's comparisons keep the Yjs content kind and the value types
// (code review round 2, M2): a string item replaced in place by an "any"
// item with the same values, or a byte array in another root normalized to
// a plain object, would read the same as JSON. Each is a post-condition,
// and nothing is returned. Item splits still compare equal.

import * as Y from '@y/y';
import {describe, expect, test} from 'vitest';

import {createYDoc} from '../../..';
import {
  migrateYState,
  type YLayoutMigration,
  YMigrationError,
} from '../../../migrate';
import {rawDoc, stamp} from '../../utils/migrateSteps';

function refusal(run: () => unknown): YMigrationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(YMigrationError);
    return error as YMigrationError;
  }
  throw new Error('the migration ran');
}

/** One string per countable unit, kinds and types unseen. */
function looseRead(node: Y.Node): string[] {
  const out: string[] = [];
  for (let it = node._start; it !== null; it = it.right) {
    if (it.deleted || !it.countable) {
      continue;
    }
    for (const v of it.content.getContent()) {
      out.push(JSON.stringify(v instanceof Y.Node ? '<node>' : v));
    }
  }
  return out;
}

describe.each([false, true])('content kinds and value types, gc %s', gc => {
  test('a string item replaced in place by an any item with the same values: post-condition', () => {
    const morph: YLayoutMigration = stamp(1, {
      migrateContainer: (_tr, node) => {
        for (let it = node._start; it !== null; it = it.right) {
          if (!it.deleted && it.content instanceof Y.ContentString) {
            it.content = new Y.ContentAny(it.content.str.split(''));
          }
        }
        return {deleted: 0, written: 0};
      },
      readAfter: looseRead,
      readBefore: looseRead,
    });
    const error = refusal(() =>
      migrateYState(rawDoc(1, 'abc'), [morph], {gc, to: 2}),
    );
    expect(error.code).toBe('post-condition');
    expect(error.problems.join('\n')).toMatch(/countable content changed/);
  });

  test('a byte array in another root normalized to a plain object: post-condition', () => {
    const d = createYDoc(rawDoc(1), {gc});
    d.get('application').setAttr('blob', new Uint8Array([1, 2, 3]) as never);
    const state = Y.encodeStateAsUpdate(d);
    d.destroy();
    const normalize = stamp(1, {
      migrateContainer: tr => {
        const it = (tr.doc as Y.Doc).get('application')._map.get('blob')!;
        it.content = new Y.ContentAny([
          JSON.parse(JSON.stringify(it.content.getContent()[0])),
        ]);
        return {deleted: 0, written: 0};
      },
    });
    const error = refusal(() => migrateYState(state, [normalize], {gc, to: 2}));
    expect(error.code).toBe('post-condition');
    expect(error.problems.join('\n')).toMatch(
      /container "application"\/root outside the root changed/,
    );
  });

  test('values JSON would merge (undefined in an array, -0, a Date) are told apart', () => {
    for (const [before, after] of [
      [
        [1, undefined],
        [1, null],
      ],
      [0, -0],
      [new Date(0), new Date(0).toISOString()],
    ] as [unknown, unknown][]) {
      const d = createYDoc(rawDoc(1), {gc});
      d.get('application').setAttr('v', before as never);
      const state = Y.encodeStateAsUpdate(d);
      d.destroy();
      const swap = stamp(1, {
        migrateContainer: tr => {
          const it = (tr.doc as Y.Doc).get('application')._map.get('v')!;
          it.content = new Y.ContentAny([after]);
          return {deleted: 0, written: 0};
        },
      });
      expect(
        refusal(() => migrateYState(state, [swap], {gc, to: 2})).code,
      ).toBe('post-condition');
    }
  });

  test('a leaf changed 70 levels deep in another root: post-condition', () => {
    let deep: Record<string, unknown> = {value: 1};
    for (let i = 0; i < 70; i++) {
      deep = {next: deep};
    }
    const d = createYDoc(rawDoc(1), {gc});
    d.get('application').setAttr('deep', deep as never);
    const state = Y.encodeStateAsUpdate(d);
    d.destroy();
    const leafOf = (v: unknown) => {
      let x = v as Record<string, unknown>;
      for (let i = 0; i < 70; i++) {
        x = x.next as Record<string, unknown>;
      }
      return x;
    };
    const mutate = stamp(1, {
      migrateContainer: tr => {
        leafOf((tr.doc as Y.Doc).get('application').getAttr('deep')).value = 2;
        return {deleted: 0, written: 0};
      },
    });
    expect(
      refusal(() => migrateYState(state, [mutate], {gc, to: 2})).code,
    ).toBe('post-condition');
    // Control: the same deep value unchanged migrates, and stays.
    const result = migrateYState(state, [stamp(1)], {gc, to: 2});
    const out = createYDoc(result.state, {gc});
    expect(leafOf(out.get('application').getAttr('deep')).value).toBe(1);
    out.destroy();
  });

  test('an empty array given one hole in place: post-condition', () => {
    const d = createYDoc(rawDoc(1), {gc});
    d.get('application').setAttr('array', [] as never);
    const state = Y.encodeStateAsUpdate(d);
    d.destroy();
    const grow = stamp(1, {
      migrateContainer: tr => {
        (
          (tr.doc as Y.Doc).get('application').getAttr('array') as unknown[]
        ).length = 1;
        return {deleted: 0, written: 0};
      },
    });
    expect(refusal(() => migrateYState(state, [grow], {gc, to: 2})).code).toBe(
      'post-condition',
    );
  });

  test('a value made to contain itself in place: post-condition, not equal', () => {
    const d = createYDoc(rawDoc(1), {gc});
    d.get('application').setAttr('loop', {a: 1} as never);
    const state = Y.encodeStateAsUpdate(d);
    d.destroy();
    const loop = stamp(1, {
      migrateContainer: tr => {
        const v = (tr.doc as Y.Doc).get('application').getAttr('loop') as {
          self?: unknown;
        };
        v.self = v;
        return {deleted: 0, written: 0};
      },
    });
    expect(refusal(() => migrateYState(state, [loop], {gc, to: 2})).code).toBe(
      'post-condition',
    );
  });

  test('control: a document with binary, embeds and split string items migrates', () => {
    const d = createYDoc(rawDoc(1, 'abcdef'), {gc});
    const root = d.get('lexical-y');
    d.get('application').setAttr('blob', new Uint8Array([9]) as never);
    // Split the string item by a format in the middle (a key the step
    // does not rewrite).
    root.format(2, 2, {'f:bold': true} as never);
    const result = migrateYState(Y.encodeStateAsUpdate(d), [stamp(1)], {
      gc,
      to: 2,
    });
    expect(result.receipt.changed).toBe(true);
    const out = createYDoc(result.state, {gc});
    expect(out.get('application').getAttr('blob')).toEqual(new Uint8Array([9]));
    out.destroy();
    d.destroy();
  });
});
