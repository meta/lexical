/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Layout3 stores what Yjs's own
// encoder (JSON.stringify, toJSON honoured) gives for a value, and refuses
// before any write a value that encodes to nothing.
import * as Y from '@y/y';
import {expect, test} from 'vitest';

import {
  readLayout4Formats,
  writeLayout4Formats,
} from '../../migrate/3to4/frozen/layout4';

class HiddenUndefined {
  toJSON() {
    return undefined;
  }
}
for (const gc of [false, true]) {
  test(`refuse a value the actual JSON encoder cannot encode before mutation gc=${gc}`, () => {
    const doc = new Y.Doc({gc});
    doc.cleanupFormatting = false;
    doc.clientID = 7;
    const root = doc.get('c');
    root.insert(0, 'abc');
    root.format(0, 3, {'f:bold': true});
    const before = Y.encodeStateAsUpdate(doc);
    const clock = doc.store.getClock(7);
    const value = new HiddenUndefined();
    expect(JSON.stringify(value)).toBeUndefined();
    let refused = false;
    try {
      doc.transact(tr =>
        writeLayout4Formats(
          tr,
          root,
          Array.from({length: 3}, () => new Map([['p:meta', value]])),
        ),
      );
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    expect(doc.store.getClock(7)).toBe(clock);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
  test(`raw array escaping follows native JSON representation gc=${gc}`, () => {
    const doc = new Y.Doc({gc});
    doc.cleanupFormatting = false;
    doc.clientID = 7;
    const root = doc.get('c');
    root.insert(0, 'a');
    const value = [new Date('2000-01-01T00:00:00.000Z')];
    doc.transact(tr =>
      writeLayout4Formats(tr, root, [new Map([['p:meta', value]])]),
    );
    const stored = readLayout4Formats(root)[0].get('p:meta') as {json: string};
    expect(JSON.parse(stored.json)).toEqual(JSON.parse(JSON.stringify(value)));
  });
}

for (const gc of [false, true]) {
  test(`values are stored as their JSON (toJSON, dropped properties), objects and arrays alike gc=${gc}`, () => {
    const doc = new Y.Doc({gc});
    doc.cleanupFormatting = false;
    doc.clientID = 7;
    const root = doc.get('c');
    root.insert(0, 'ab');
    const date = new Date('2000-01-01T00:00:00.000Z');
    doc.transact(tr =>
      writeLayout4Formats(tr, root, [
        new Map<string, unknown>([['p:when', {at: date, f: () => 1}]]),
        new Map<string, unknown>([['p:when', date]]),
      ]),
    );
    const read = readLayout4Formats(root);
    expect(read[0].get('p:when')).toEqual({at: '2000-01-01T00:00:00.000Z'});
    expect(read[1].get('p:when')).toBe('2000-01-01T00:00:00.000Z');
    // A reload reads the same.
    const again = new Y.Doc({gc});
    again.cleanupFormatting = false;
    Y.applyUpdate(again, Y.encodeStateAsUpdate(doc));
    expect(readLayout4Formats(again.get('c'))).toEqual(read);
  });
}
