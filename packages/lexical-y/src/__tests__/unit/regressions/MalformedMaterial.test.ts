/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Malformed quarantine material (code review): bytes that are not a
// well-formed Yjs update make createYQuarantineRecord throw, as y-server.md
// says, so a server keeps the raw upload; a record over well-formed material
// reads, and its source view is complete.

import * as Y from '@y/y';
import {describe, expect, test} from 'vitest';

import {
  createYQuarantineRecord,
  sourceView,
  type YRecordSource,
} from '../../../server';

const SOURCE: YRecordSource = {
  generation: null,
  incarnation: null,
  layouts: null,
  renderer: null,
  schemaVersion: null,
};

function v1Update(gc: boolean): Uint8Array {
  const doc = new Y.Doc({gc});
  doc.get('x').insert(0, 'text');
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

describe.each([false, true])('malformed quarantine material, gc %s', gc => {
  test('truncated or garbage bytes throw; well-formed bytes read', () => {
    const good = v1Update(gc);
    for (const bad of [
      good.subarray(0, 2),
      new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]),
    ]) {
      expect(() =>
        createYQuarantineRecord({
          kind: 'capture',
          receivedAt: 1,
          snapshot: bad,
          source: SOURCE,
        }),
      ).toThrow();
    }
    const record = createYQuarantineRecord({
      kind: 'capture',
      receivedAt: 1,
      snapshot: good,
      source: SOURCE,
    });
    expect(record.complete).toBe(true);
    const view = sourceView(record);
    expect(view.complete).toBe(true);
    view.doc.destroy();
  });
});
