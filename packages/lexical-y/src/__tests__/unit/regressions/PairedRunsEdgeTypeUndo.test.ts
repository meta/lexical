/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Paired runs (spec v4.6, ID-prop-3): text typed plain right after a format
// change's range, where a collaborator's paired run opens or the word's own
// pre-upgrade closers follow, stays out of the change's run, so the change's
// undo leaves it plain. Six random-session
// runs reduced from the property suite (main shape: "def" bold; A types a
// plain "0" inside it; B unbolds a range ending at "d"; A types a plain "1"
// between "d" and "0"; B undoes: "1" stays plain), each with the switch on
// and off, gc off and on. Oracle: letters keep their formats, digits stay
// plain, no "Z" is left, the peers converge.

import {afterEach, expect, test} from 'vitest';

import {setFormatIdentityWritesDefault} from '../../utils/noSwitch';
import {type Run, run} from '../../utils/opsRun';

const RUNS: Run[] = [
  {
    ids: [2, 1],
    key: '7020855:21-min',
    ops: [
      ['insZ', 2],
      ['type', 10, '0'],
      'sync',
      ['unformat', 7, 12, 'b'],
      'sync',
      ['type', 0, '1'],
      ['type', 12, '2'],
      'undo',
      'undo',
    ],
    words: [
      ['abc', 'is'],
      ['def', 'bi'],
      ['ghi', 'b'],
      ['jkl', 'b'],
    ],
  },
  {
    ids: [2, 1],
    key: '7119717:21-min',
    ops: [
      ['type', 4, '0'],
      'sync',
      ['unformat', 1, 4, 'b'],
      'sync',
      ['type', 4, '1'],
      'undo',
    ],
    words: [
      ['abc', 'i'],
      ['def', 'b'],
      ['ghi', ''],
    ],
  },
  {
    ids: [2, 1],
    key: '7138816:21-min',
    ops: [
      ['type', 8, '0'],
      'sync',
      ['unformat', 7, 9, 'b'],
      'sync',
      ['type', 1, '1'],
      ['type', 9, '2'],
      'undo',
    ],
    words: [
      ['abc', 'is'],
      ['def', ''],
      ['ghi', 'bi'],
    ],
  },
  {
    ids: [2, 1],
    key: '7042063:21-min',
    ops: [
      ['type', 5, '0'],
      'sync',
      ['unformat', 2, 5, 'b'],
      'sync',
      ['type', 2, '1'],
      ['type', 6, '2'],
      'undo',
    ],
    words: [
      ['abc', 'is'],
      ['def', 'bs'],
      ['ghi', ''],
    ],
  },
  {
    ids: [1, 2],
    key: '7082488:12-min',
    ops: [
      ['type', 8, '0'],
      'sync',
      ['unformat', 7, 8, 'b'],
      'sync',
      ['type', 0, '2'],
      ['type', 9, '3'],
      'undo',
    ],
    words: [
      ['abc', ''],
      ['def', 'b'],
      ['ghi', 'bs'],
      ['jkl', 'bs'],
    ],
  },
  {
    ids: [1, 2],
    key: '7189628:12-min',
    ops: [
      ['insZ', 4],
      ['type', 13, '0'],
      ['type', 0, '1'],
      ['insZ', 8],
      'sync',
      ['unformat', 12, 16, 'b'],
      ['type', 13, '2'],
      'sync',
      ['type', 17, '3'],
      'undo',
      'undo',
      'undo',
    ],
    words: [
      ['abc', 's'],
      ['def', ''],
      ['ghi', ''],
      ['jkl', 'i'],
      ['mno', 'b'],
    ],
  },
];

// B removes a format from part of a formatted (seeded, pre-upgrade) word; A
// types a plain digit right after the removed part, where B's run ends
// before the word's own closers; B undoes: the digit stays plain (the
// insert lands past the closers that already give it its formats, not
// inside B's run).
const UNFORMAT_TYPE_UNDO: Run[] = [
  {
    ids: [2, 1],
    key: '7040798:21-min',
    ops: [['unformat', 5, 7, 'b'], 'sync', ['type', 6, '1'], 'undo'],
    words: [
      ['abc', ''],
      ['def', 'bs'],
      ['ghi', ''],
    ],
  },
  {
    ids: [1, 2],
    key: '7162129:12-min',
    ops: [['unformat', 2, 5, 's'], 'sync', ['type', 3, '0'], 'undo'],
    words: [
      ['abc', 's'],
      ['def', ''],
      ['ghi', 's'],
      ['jkl', 'i'],
    ],
  },
  {
    ids: [2, 1],
    key: '7019732:21-min',
    ops: [
      ['unformat', 4, 6, 's'],
      ['type', 4, '0'],
      'sync',
      ['type', 7, '1'],
      'undo',
    ],
    words: [
      ['abc', 's'],
      ['def', 'is'],
      ['ghi', 'b'],
      ['jkl', 'is'],
    ],
  },
  {
    ids: [1, 2],
    key: '7073256:12-min',
    ops: [['unformat', 2, 6, 'b'], 'sync', ['type', 3, '1'], 'undo'],
    words: [
      ['abc', 'b'],
      ['def', ''],
      ['ghi', 'b'],
    ],
  },
  {
    ids: [2, 1],
    key: '7035837:21-min',
    ops: [
      ['unformat', 8, 9, 'i'],
      ['type', 7, '1'],
      'sync',
      ['type', 10, '3'],
      'undo',
    ],
    words: [
      ['abc', 'b'],
      ['def', 's'],
      ['ghi', 'i'],
      ['jkl', ''],
      ['mno', 'b'],
    ],
  },
  {
    ids: [2, 1],
    key: '7140429:21-min',
    ops: [
      ['unformat', 8, 9, 'i'],
      ['type', 6, '0'],
      'sync',
      ['type', 6, '1'],
      ['type', 11, '2'],
      'undo',
    ],
    words: [
      ['abc', 's'],
      ['def', 'i'],
      ['ghi', 'i'],
      ['jkl', ''],
    ],
  },
];

afterEach(() => {
  setFormatIdentityWritesDefault(false);
});

for (const on of [false, true]) {
  for (const gc of [false, true]) {
    for (const spec of [...RUNS, ...UNFORMAT_TYPE_UNDO]) {
      test(`switch ${on ? 'on' : 'off'}, gc ${gc ? 'on' : 'off'}: run ${spec.key} keeps the typed digits plain and every letter's format`, () => {
        setFormatIdentityWritesDefault(on);
        expect(run(spec, gc)).toBe('');
      });
    }
  }
}
