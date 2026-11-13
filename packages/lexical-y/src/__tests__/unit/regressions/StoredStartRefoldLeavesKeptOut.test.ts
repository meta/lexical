/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A start formats map the writer folds as stored (a held insertion counts,
// a deleted item the hold keeps showing does not, see Shown.isStoredIn) is
// noted with that lane: when its fold point goes stale and the map is
// folded again (see Seen.frontierOf), the refold leaves the kept deletions
// out as the first fold did. It refolded over what the write's view shows,
// and the kept items came back into the stored start.
import * as Y from '@y/y';
import {expect, test} from 'vitest';

import {Hidden} from '../../../internal/Hidden';
import {writeLayout3Formats} from '../../../internal/Layout3';
import {frontierOf, noteFolded} from '../../../internal/Seen';
import {isStoredIn} from '../../../internal/Shown';
import {emptyView} from '../../../internal/Unread';

for (const gc of [false, true]) {
  test(`a stored start folded again leaves the hold's kept deletions out (gc ${gc})`, () => {
    const doc = new Y.Doc({gc});
    const root = doc.get('lexical-y');
    root.setAttr('lexical-y:3', true);
    root.insert(0, 'abcd');
    const oldBoundary = new Y.Node('\u00b6');
    root.insert(4, [oldBoundary]);
    doc.transact(tr =>
      writeLayout3Formats(tr, root, [
        new Map([['f:bold', true]]),
        new Map([['f:bold', true]]),
        new Map([['f:bold', true]]),
        new Map([['f:bold', true]]),
        new Map(),
      ]),
    );
    const hidden = new Hidden('line');
    const formats: Y.Item[] = [];
    for (let it = root._start; it; it = it.right) {
      if (it.content instanceof Y.ContentFormat) formats.push(it);
    }
    doc.transact(tr =>
      formats.forEach(it => {
        hidden.keep(it);
        it.delete(tr);
      }),
    );
    const newBoundary = new Y.Node('\u00b6');
    root.insert(2, [newBoundary]);
    const to = oldBoundary._item!;
    const left = newBoundary._item!;
    const stored = new Map<string, unknown>();
    // The note the writer puts on a start it folds as stored.
    noteFolded(stored, to, 'stored', hidden);
    const rawControl = new Map<string, unknown>();
    noteFolded(rawControl, to, 'raw');
    doc.transact(tr => to.delete(tr));
    const view = emptyView(root, it => hidden.keeps(it));
    expect(formats.every(it => !isStoredIn(view, it, hidden))).toBe(true);
    frontierOf(view, rawControl, left, root, null);
    expect(rawControl.get('f:bold')).toBeUndefined();
    frontierOf(view, stored, left, root, null);
    expect(stored.get('f:bold')).toBeUndefined();
    hidden.releaseKeeps();
    doc.destroy();
  });
}
