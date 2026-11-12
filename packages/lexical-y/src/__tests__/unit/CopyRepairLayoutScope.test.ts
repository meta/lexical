/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The copy repair of ends an undo or redo
// restores changes nothing in a root below layout 3 (main keeps a raw
// writer's `[1]` as stored); a root that records layout 3 is repaired.
import * as Y from '@y/y';
import {expect, test} from 'vitest';

import {createYDoc} from '../..';

for (const gc of [false, true])
  for (const layout of [1, 2]) {
    test(`copy repair leaves older-layout app undo bytes alone layout=${layout} gc=${gc}`, () => {
      const doc = createYDoc(null, {gc});
      doc.clientID = 7;
      const root = doc.get('lexical-y');
      root.setAttr('lexical-y:' + layout, true);
      root.insert(0, 'abc');
      const app = new Y.UndoManager(root, {
        captureTimeout: 0,
        deleteFilter: it =>
          it.content instanceof Y.ContentFormat &&
          Array.isArray(it.content.value),
        trackedOrigins: new Set(['raw']),
      });
      doc.transact(tr => {
        const right = root._start;
        const opener = new Y.Item(
          Y.createID(7, doc.store.getClock(7)),
          null,
          null,
          right,
          right!.id,
          root,
          null,
          new Y.ContentFormat('f:bold', true as never),
        );
        opener.integrate(tr, 0);
        const text = opener.right!;
        const end = new Y.Item(
          Y.createID(7, doc.store.getClock(7)),
          text,
          text.lastId,
          null,
          null,
          root,
          null,
          new Y.ContentFormat('f:bold', [1] as never),
        );
        end.integrate(tr, 0);
      }, 'raw');
      app.undo();
      app.redo();
      let last: unknown;
      for (let it = root._start; it; it = it.right)
        if (
          !it.deleted &&
          it.content instanceof Y.ContentFormat &&
          Array.isArray(it.content.value)
        )
          last = it.content.value;
      expect(last).toEqual([1]);
      app.destroy();
      doc.destroy();
    });
  }

// A layout 4 runtime repairs layout 3 roots (by layout 3's names)
// and layout 4 roots.
for (const layout of [3, 4])
  for (const gc of [false, true]) {
    test(`copy repair still repairs a root that records layout ${layout} gc=${gc}`, () => {
      const doc = createYDoc(null, {gc});
      doc.clientID = 7;
      const root = doc.get('lexical-y');
      root.setAttr('lexical-y:1', true);
      root.setAttr('lexical-y:' + layout, true);
      root.insert(0, 'abc');
      const app = new Y.UndoManager(root, {
        captureTimeout: 0,
        deleteFilter: it =>
          it.content instanceof Y.ContentFormat &&
          Array.isArray(it.content.value),
        trackedOrigins: new Set(['raw']),
      });
      doc.transact(tr => {
        const right = root._start;
        const opener = new Y.Item(
          Y.createID(7, doc.store.getClock(7)),
          null,
          null,
          right,
          right!.id,
          root,
          null,
          new Y.ContentFormat('f:bold', true as never),
        );
        opener.integrate(tr, 0);
        const text = opener.right!;
        const end = new Y.Item(
          Y.createID(7, doc.store.getClock(7)),
          text,
          text.lastId,
          null,
          null,
          root,
          null,
          new Y.ContentFormat('f:bold', [1] as never),
        );
        end.integrate(tr, 0);
      }, 'raw');
      app.undo();
      app.redo();
      let last: unknown;
      for (let it = root._start; it; it = it.right) {
        if (
          !it.deleted &&
          it.content instanceof Y.ContentFormat &&
          Array.isArray(it.content.value)
        ) {
          last = it.content.value;
        }
      }
      // The redo's copy names the opener again (it is 2 clocks after it now).
      expect(last).not.toEqual([1]);
      app.destroy();
      doc.destroy();
    });
  }
