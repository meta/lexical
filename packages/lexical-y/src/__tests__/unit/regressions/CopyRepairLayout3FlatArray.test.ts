/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The copy repair's negative control: in a root that records
// layout 3, a flat NodeState name (`s:<key>`, no U+001F) was plain, so an
// array under it is a value, not an end. The copy an app undo's redo makes
// of it keeps its value: the repair, which re-points copies of ends in
// layout 3 roots by layout 3's names, leaves it as stored. The same item
// under a layout 3 name (`f:bold`) is repaired; in a layout 4 root both are.

import * as Y from '@y/y';
import {expect, test} from 'vitest';

import {createYDoc} from '../../..';

/** The last live array value of `root` after a raw write, undo and redo. */
function copiedValue(gc: boolean, layout: number, key: string): unknown {
  const doc = createYDoc(null, {gc});
  doc.clientID = 7;
  const root = doc.get('lexical-y');
  root.setAttr('lexical-y:1', true);
  root.setAttr('lexical-y:' + layout, true);
  root.insert(0, 'abc');
  const app = new Y.UndoManager(root, {
    captureTimeout: 0,
    deleteFilter: it =>
      it.content instanceof Y.ContentFormat && Array.isArray(it.content.value),
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
      new Y.ContentFormat(key, 'red' as never),
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
      new Y.ContentFormat(key, [1] as never),
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
  app.destroy();
  doc.destroy();
  return last;
}

for (const gc of [false, true]) {
  test(`a flat NodeState array copied in a layout 3 root keeps its value (gc ${gc})`, () => {
    expect(copiedValue(gc, 3, 's:color')).toEqual([1]);
  });

  test(`a layout 3 name's end copied in a layout 3 root is repaired (gc ${gc})`, () => {
    // The redo's copy names the opener again (2 clocks after it now).
    expect(copiedValue(gc, 3, 'f:bold')).not.toEqual([1]);
  });

  test(`a flat NodeState end copied in a layout 4 root is repaired (gc ${gc})`, () => {
    expect(copiedValue(gc, 4, 's:color')).not.toEqual([1]);
  });
}
