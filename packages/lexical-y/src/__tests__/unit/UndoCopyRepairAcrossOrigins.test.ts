/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Copy repair of ends an undo restores, whatever the transaction's origin or
// locality: an UndoManager that tracks remote deletions (top-level and nested
// roots), an undo run inside the beforeTransaction of an incoming update, and
// an app's outer transaction that mixes a local undo with applyUpdate (in
// either order, which leaves the transaction non-local). The restored end
// must name its opener in the document and after a reload, gc off and on.

import * as Y from '@y/y';
import {expect, test} from 'vitest';

import {createYDoc} from '../..';
import {isValidEnd, STORED_FOLD} from '../../internal/Ident';
import {writeLayout3Formats} from '../../internal/Layout3';

function root(d: Y.Doc): Y.Node {
  return d.share.has('app')
    ? (d.get('app').getAttr('editor') as Y.Node)
    : d.get('c');
}
/** "ab" bold as one paired run, in a top-level or a nested root. */
function source(gc: boolean, nested = false): Y.Doc {
  const d = createYDoc(null, {gc});
  d.clientID = 11;
  const r = nested ? new Y.Node('editor') : d.get('c');
  if (nested) {
    d.get('app').setAttr('editor', r);
  }
  r.setAttr('lexical-y:3', true);
  r.insert(0, 'ab');
  d.transact(tr =>
    writeLayout3Formats(tr, r, [
      new Map([['f:bold', true]]),
      new Map([['f:bold', true]]),
    ]),
  );
  return d;
}
/** The root's live end. */
function end(d: Y.Doc): Y.Item {
  for (let i = root(d)._start; i; i = i.right as Y.Item | null) {
    if (
      !i.deleted &&
      i.content instanceof Y.ContentFormat &&
      Array.isArray(i.content.value) &&
      i.content.value.length
    ) {
      return i;
    }
  }
  throw new Error('no end');
}
/** An update unrelated to the root (another client's activity record). */
function activity(): Uint8Array {
  const d = new Y.Doc();
  d.clientID = 901;
  d.get('activity').setAttr('event', true);
  const u = Y.encodeStateAsUpdate(d);
  d.destroy();
  return u;
}

for (const gc of [false, true]) {
  test(`an undo of a remote deletion an UndoManager captured in a nested root restores a valid end (gc ${gc})`, () => {
    const s = source(gc, true);
    const d = createYDoc(Y.encodeStateAsUpdate(s), {gc});
    d.clientID = 77;
    const um = new Y.UndoManager(root(d), {
      captureTimeout: 0,
      captureTransaction: tr =>
        tr.origin === 'remote' || typeof tr.origin === 'object',
      trackedOrigins: new Set(['remote']),
    });
    const sv = Y.encodeStateVector(s);
    s.transact(tr => end(s).delete(tr));
    Y.applyUpdate(d, Y.encodeStateAsUpdate(s, sv), 'remote');
    expect(um.canUndo()).toBe(true);
    um.undo();
    const loaded = createYDoc(Y.encodeStateAsUpdate(d), {gc});
    expect(isValidEnd(end(loaded), STORED_FOLD)).toBe(true);
  });

  test(`an undo run inside an incoming update's beforeTransaction restores a valid end (gc ${gc})`, () => {
    const s = source(gc);
    const d = createYDoc(Y.encodeStateAsUpdate(s), {gc});
    d.clientID = 77;
    const original = end(d);
    const um = new Y.UndoManager(d, {
      captureTimeout: 0,
      trackedOrigins: new Set(['delete']),
    });
    d.transact(tr => original.delete(tr), 'delete');
    const before = (tr: Y.Transaction) => {
      if (tr.origin === 'remote') {
        d.off('beforeTransaction', before);
        um.undo();
      }
    };
    d.on('beforeTransaction', before);
    Y.applyUpdate(d, activity(), 'remote');
    const loaded = createYDoc(Y.encodeStateAsUpdate(d), {gc});
    expect(isValidEnd(end(loaded), STORED_FOLD)).toBe(true);
  });

  test(`an undo of a tracked remote deletion of a loaded end restores a valid end (gc ${gc})`, () => {
    const s = source(gc);
    const d = createYDoc(Y.encodeStateAsUpdate(s), {gc});
    d.clientID = 77;
    const um = new Y.UndoManager(d, {
      captureTimeout: 0,
      trackedOrigins: new Set(['remote']),
    });
    const sv = Y.encodeStateVector(s);
    s.transact(tr => end(s).delete(tr));
    Y.applyUpdate(d, Y.encodeStateAsUpdate(s, sv), 'remote');
    expect(um.canUndo()).toBe(true);
    um.undo();
    const copied = end(d);
    const loaded = createYDoc(Y.encodeStateAsUpdate(d), {gc});
    expect(isValidEnd(copied, STORED_FOLD)).toBe(true);
    expect(isValidEnd(end(loaded), STORED_FOLD)).toBe(true);
    um.destroy();
    s.destroy();
    d.destroy();
    loaded.destroy();
  });

  for (const order of ['undo then update', 'update then undo'] as const) {
    test(`an app transaction mixing a local undo and applyUpdate (${order}) restores a valid end (gc ${gc})`, () => {
      const s = source(gc);
      const d = createYDoc(Y.encodeStateAsUpdate(s), {gc});
      d.clientID = 77;
      const original = end(d);
      const um = new Y.UndoManager(d, {
        captureTimeout: 0,
        trackedOrigins: new Set(['delete']),
      });
      d.transact(tr => original.delete(tr), 'delete');
      d.transact(() => {
        if (order === 'undo then update') {
          um.undo();
          Y.applyUpdate(d, activity(), 'remote');
        } else {
          Y.applyUpdate(d, activity(), 'remote');
          um.undo();
        }
      }, 'outer');
      const loaded = createYDoc(Y.encodeStateAsUpdate(d), {gc});
      expect(isValidEnd(end(loaded), STORED_FOLD)).toBe(true);
      um.destroy();
      s.destroy();
      d.destroy();
      loaded.destroy();
    });
  }
}
