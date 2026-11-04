/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A step that changes a value in place (code review round 1, M2) writes no
// item and deletes none, so the transaction's sets miss it, and the state
// the runner returns would disagree with its update. The runner compares
// every root of the document, values read deep, and checks that the input
// with the returned update gives the returned state: each case is a
// post-condition and nothing is returned or applied.

import * as Y from '@y/y';
import {describe, expect, test} from 'vitest';

import {createYDoc} from '../../..';
import {migrateYDoc} from '../../../internal/Runner';
import {
  migrateYState,
  type YLayoutMigration,
  YMigrationError,
} from '../../../migrate';
import {rawDoc, stamp} from '../../utils/migrateSteps';

/** The state at layout 1 with an application root holding a JSON value. */
function withConfig(gc: boolean): Uint8Array {
  const d = createYDoc(rawDoc(1), {gc});
  d.get('application').setAttr('config', {order: ['b', 'a']} as never);
  const out = Y.encodeStateAsUpdate(d);
  d.destroy();
  return out;
}

function refusal(run: () => unknown): YMigrationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(YMigrationError);
    return error as YMigrationError;
  }
  throw new Error('the migration ran');
}

/** One string per countable unit, formats unseen. */
function plainRead(node: Y.Node): string[] {
  const out: string[] = [];
  for (let it = node._start; it !== null; it = it.right) {
    if (it.deleted || !it.countable) {
      continue;
    }
    if (it.content instanceof Y.ContentString) {
      out.push(...it.content.str.split(''));
    } else {
      out.push('<embed>');
    }
  }
  return out;
}

const sortConfig = stamp(1, {
  migrateContainer: tr => {
    const config = (tr.doc as Y.Doc).get('application').getAttr('config') as {
      order: string[];
    };
    config.order.sort();
    return {deleted: 0, written: 0};
  },
});

describe.each([false, true])('values changed in place, gc %s', gc => {
  test("another root's JSON attribute sorted in place: post-condition, nothing returned", () => {
    const state = withConfig(gc);
    const error = refusal(() =>
      migrateYState(state, [sortConfig], {gc, to: 2}),
    );
    expect(error.code).toBe('post-condition');
    expect(error.problems.join('\n')).toMatch(
      /container "application"\/root outside the root changed/,
    );
    // The input is untouched.
    const input = createYDoc(state, {gc});
    expect(input.get('application').getAttr('config')).toEqual({
      order: ['b', 'a'],
    });
    input.destroy();
  });

  test('the same on a live document: refused, and the document unchanged', () => {
    const doc = createYDoc(withConfig(gc), {gc});
    const before = Y.encodeStateAsUpdate(doc);
    expect(refusal(() => migrateYDoc(doc, [sortConfig], {to: 2})).code).toBe(
      'post-condition',
    );
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(doc.get('application').getAttr('config')).toEqual({
      order: ['b', 'a'],
    });
    doc.destroy();
  });

  test('a format value of a key the step rewrites, changed in place: the update would not reproduce it, post-condition', () => {
    const d = createYDoc(rawDoc(1), {gc});
    const root = d.get('lexical-y');
    root.format(0, 2, {'f:color': {value: 'red'}} as never);
    const state = Y.encodeStateAsUpdate(d);
    d.destroy();
    const paint: YLayoutMigration = stamp(1, {
      migrateContainer: (_tr, node) => {
        for (let it = node._start; it !== null; it = it.right) {
          if (
            !it.deleted &&
            it.content instanceof Y.ContentFormat &&
            it.content.value !== null
          ) {
            (it.content.value as {value: string}).value = 'blue';
          }
        }
        return {deleted: 0, written: 0};
      },
      // Reads that do not see formats: only the update check can tell.
      readAfter: plainRead,
      readBefore: plainRead,
      rewrites: key => key.startsWith('f:'),
    });
    const error = refusal(() => migrateYState(state, [paint], {gc, to: 2}));
    expect(error.code).toBe('post-condition');
    expect(error.problems.join('\n')).toMatch(
      /the input with the update differs from the result/,
    );
  });

  test('a step that writes nothing outside its root still migrates, and the update brings the input to the state', () => {
    const state = withConfig(gc);
    const result = migrateYState(state, [stamp(1)], {gc, to: 2});
    const viaUpdate = createYDoc(state, {gc});
    Y.applyUpdate(viaUpdate, result.update!);
    const after = createYDoc(result.state, {gc});
    expect(viaUpdate.get('application').getAttr('config')).toEqual(
      after.get('application').getAttr('config'),
    );
    expect(Y.encodeStateVector(viaUpdate)).toEqual(Y.encodeStateVector(after));
    viaUpdate.destroy();
    after.destroy();
  });
});
