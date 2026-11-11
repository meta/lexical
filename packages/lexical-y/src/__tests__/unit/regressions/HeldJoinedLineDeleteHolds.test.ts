/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A collaborator's removal of a line joined into the line before it, while
// another client composes in it, holds: A composes in the code line
// `let x = 1;`; B joins it into the paragraph `ABCDGH ` before it and appends
// a code block `let untouched = 1;` (underlined, two NodeState values); B,
// offline, removes the joined paragraph; A's ending update clears one
// NodeState key on part of `let x = 1;`, and B's removal reaches A right
// after A's ending write (Prism, its stock tokenizer, highlighting on both
// peers). Every peer and a fresh reader end with the untouched block alone.
// With #9860's marker rule the removed text came back, inside B's code
// block, on every client. A carry-lane history (see utils/lanes/carry),
// minimized, replayed through the lane.

import {expect, test, vi} from 'vitest';

import {carryLane} from '../../utils/lanes/carry';

const HISTORY = {
  cfg: {
    codeInit: [null, null],
    decor: false,
    deleteHeld: true,
    format: [0, 0, 0],
    hlScope: 'all',
    init: [
      [null, null],
      [null, null],
      [null, null],
    ],
    keys: [
      {flatHl: false, flatText: false, name: 'k-c', shape: 'scalar'},
      {flatHl: false, flatText: false, name: 'k-b', shape: 'object'},
    ],
    ops: [
      {
        e: 0.9217863401863724,
        ki: 1,
        kind: 'clear',
        s: 0.39490715600550175,
      },
    ],
    ownFoo: ['MISSING', 'MISSING', 'MISSING'],
    split: [6],
    storedCls: ['plain', 'plain', 'plain'],
    style: ['', '', ''],
    tokenizer: {base: 'Prism', created: 'stock', kind: 'drop'},
    untouched: 'code',
    untouchedVals: ['s1', {a: 1}],
    variant: 'join',
  },
  gc: false,
  ids: [2, 1],
  lane: 'carry',
  seed: 315700039,
};

for (const gc of [false, true]) {
  test(`a collaborator's removal of the held line it joined holds (gc ${gc ? 1 : 0})`, async () => {
    const lines: string[] = [];
    const prev = process.env.LANE_TRACE;
    process.env.LANE_TRACE = '1';
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => {
      lines.push(a.map(String).join(' '));
    });
    let findings;
    try {
      findings = await carryLane.run({...HISTORY, gc} as never);
    } finally {
      spy.mockRestore();
      process.env.LANE_TRACE = prev;
    }
    const fresh =
      lines
        .join('\n')
        .split('\n')
        .filter(l => l.startsWith('  fresh: '))
        .pop() ?? '';
    expect(fresh).toContain('untouched');
    expect(fresh).not.toContain('" x "');
    expect(fresh).not.toContain('x = 1');
    expect(findings.map(f => f.cls)).toEqual([]);
  }, 60_000);
}
