/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Names the binding does not own: every name it writes on
// text is covered, so any other name is a raw writer's. An explicit format
// change of such a name (or of one starting with U+0002, the reader's own
// bookkeeping) is refused before anything is written. Inserted content never
// negates or restores one: it takes the value the name has at the cursor.

import * as Y from '@y/y';
import {describe, expect, test} from 'vitest';

import {Cursor} from '../../../internal/Cursor';

function doc(): Y.Doc {
  const d = new Y.Doc();
  d.clientID = 1;
  d.cleanupFormatting = false;
  d.get('lexical-y').setAttr('lexical-y:4', true);
  return d;
}

const formatItems = (d: Y.Doc): string[] => {
  const out: string[] = [];
  for (let it = d.get('t')._start; it !== null; it = it.right) {
    if (!it.deleted && it.content instanceof Y.ContentFormat) {
      out.push(`${it.content.key}=${JSON.stringify(it.content.value)}`);
    }
  }
  return out;
};

describe('names the binding does not own', () => {
  for (const key of ['foreign', 'x:y', '\u0002f:bold']) {
    test(`a format change of ${JSON.stringify(key)} is refused, nothing written`, () => {
      const d = doc();
      d.get('t').insert(0, 'abc');
      const before = Y.encodeStateVector(d);
      expect(() =>
        d.transact(tr => {
          const cursor = new Cursor(tr, d.get('t'), null, new Map());
          cursor.format(2, {'f:bold': true, [key]: 'v'});
        }),
      ).toThrow(/does not own/);
      expect(Y.encodeStateVector(d)).toEqual(before);
    });
  }

  test('text inserted inside a raw writer’s value takes it: no item of that name is written', () => {
    const d = doc();
    const t = d.get('t');
    t.insert(0, 'abcd');
    // A raw writer's value over "bc".
    t.format(1, 2, {foreign: 'v'});
    const raw = formatItems(d);
    d.transact(tr => {
      const cursor = new Cursor(tr, t, null, new Map());
      cursor.advance(2);
      // The writer gives only the names it owns.
      cursor.insert(new Y.ContentString('X'), {'f:bold': true});
    });
    expect(formatItems(d).filter(i => i.startsWith('foreign'))).toEqual(
      raw.filter(i => i.startsWith('foreign')),
    );
    const delta = t.toDelta().toJSON() as {
      children: {insert: string; format?: Record<string, unknown>}[];
    };
    const x = delta.children.find(c => c.insert.includes('X'));
    expect(x?.format?.foreign).toBe('v');
  });
});
