/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A start folded as stored (see Shown.FoldLane) up to a format item: once a
// change deletes that item and the hold keeps showing it, the item is no
// fold point of the stored start any more (a kept deletion is not stored).
// Its frontier check took it for live (what the write's view shows), and
// the start kept the stale format.
import * as Y from '@y/y';
import {expect, test} from 'vitest';

import {createYDoc} from '../../..';
import {Hidden} from '../../../internal/Hidden';
import {stepFormat, STORED_FOLD} from '../../../internal/Ident';
import {frontierOf, noteFolded} from '../../../internal/Seen';
import {isStoredIn} from '../../../internal/Shown';
import {emptyView} from '../../../internal/Unread';
import {writeLayout4Formats} from '../../../migrate/3to4/frozen/layout4';

for (const gc of [false, true]) {
  test(`a stored start's fold point that only the hold shows is folded again (gc ${gc})`, () => {
    const doc = createYDoc(null, {gc});
    const root = doc.get('lexical-y');
    root.setAttr('lexical-y:5', true);
    root.insert(0, 'abcd');
    const boundary = new Y.Node('¶');
    root.insert(0, [boundary]);
    doc.transact(tr =>
      writeLayout4Formats(tr, root, [
        new Map(),
        ...Array.from({length: 4}, () => new Map([['f:bold', true]])),
      ]),
    );
    const formats: Y.Item[] = [];
    for (let it = root._start; it; it = it.right) {
      if (it.content instanceof Y.ContentFormat) formats.push(it);
    }
    const to = formats.find(
      it => (it.content as Y.ContentFormat).value === true,
    )!;
    expect(to).toBeDefined();
    const start = new Map<string, unknown>();
    stepFormat(start, to, STORED_FOLD);
    expect(start.get('f:bold')).toBe(true);
    const hidden = new Hidden('line');
    noteFolded(start, to, 'stored', hidden);
    // A complete deleted run, kept together, as Reader.runInLine allows.
    doc.transact(tr =>
      formats.forEach(it => {
        hidden.keep(it);
        it.delete(tr);
      }),
    );
    const left = boundary._item!;
    const view = emptyView(root, it => hidden.keeps(it));
    expect(isStoredIn(view, to, hidden)).toBe(false);
    const raw = new Map<string, unknown>(start);
    noteFolded(raw, to, 'raw');
    frontierOf(view, raw, left, root, null);
    expect(raw.get('f:bold')).toBeUndefined();
    frontierOf(view, start, left, root, null);
    expect(start.get('f:bold')).toBeUndefined();
    hidden.releaseKeeps();
    doc.destroy();
  });
}
