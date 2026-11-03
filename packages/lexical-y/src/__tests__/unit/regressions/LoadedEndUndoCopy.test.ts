/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Ends that arrived in an update (a stored state loaded, or a remote change)
// get no holder when they arrive: a holder is noted when a local transaction
// deletes one, so that an undo restoring it as a copy (which shares the
// value array) is still repaired to name its opener (see Ident.repairCopies).

import * as Y from '@y/y';
import {$getRoot, $setSelection} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc} from '../../..';
import {isValidEnd} from '../../../internal/Ident';
import {$p, $selectIn, setup} from '../../utils/harness';

for (const gc of [false, true]) {
  for (const route of ['loaded', 'remote'] as const) {
    test(`an undo's copy of an end that arrived in an update names its opener (${route}, gc ${gc})`, async () => {
      const t = await setup(() => $getRoot().append($p('alpha beta gamma')), {
        gc,
      });
      t.a.update(() => {
        $selectIn([0], 6, 10).formatText('bold');
        $setSelection(null);
      });
      await t.sync();
      const state = Y.encodeStateAsUpdate(t.a.doc);
      let doc: Y.Doc;
      if (route === 'loaded') {
        doc = createYDoc(state, {gc});
      } else {
        doc = createYDoc(null, {gc});
        Y.applyUpdate(doc, state, 'remote');
      }
      const root = doc.get('lexical-y') as unknown as {_start: Y.Item | null};
      const isEnd = (it: Y.Item) =>
        it.content instanceof Y.ContentFormat &&
        it.content.key === 'f:bold' &&
        Array.isArray(it.content.value) &&
        (it.content.value as unknown[]).length > 0;
      let end: Y.Item | null = null;
      for (let it = root._start; it !== null; it = it.right) {
        if (!it.deleted && isEnd(it)) {
          end = it;
        }
      }
      expect(end).not.toBeNull();
      expect(isValidEnd(end!)).toBe(true);
      // A local, tracked transaction deletes the end alone; its undo
      // restores it as a copy at a new clock, its opener untouched.
      const um = new Y.UndoManager(doc as never, {
        captureTimeout: 0,
        trackedOrigins: new Set(['local']),
      });
      doc.transact(tr => {
        end!.delete(tr);
      }, 'local');
      um.undo();
      let copy: Y.Item | null = null;
      for (let it = root._start; it !== null; it = it.right) {
        if (!it.deleted && isEnd(it)) {
          copy = it;
        }
      }
      expect(copy).not.toBeNull();
      expect(copy).not.toBe(end);
      expect(isValidEnd(copy!)).toBe(true);
      um.destroy();
      doc.destroy();
    });
  }
}
