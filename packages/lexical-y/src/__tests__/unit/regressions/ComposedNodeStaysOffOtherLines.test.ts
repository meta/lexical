/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The node a client composes in never goes to another line: A composes in
// `see word` (before `intro`); B converts that paragraph to a heading (an app
// heading transform on every peer appends `!`) and inserts a paragraph after
// it in the same update, so the line A composes in gets a new marker (D118)
// and A reads B's change at once; A's update that ends the composition sets a
// NodeState value on its node. Before, the read took the composed line's
// marker for merged into the line after it and gave that line A's composed
// node: the value landed on `intro`, on every client.
// A blockconv-lane history (see utils/lanes/blockconv), minimized, replayed
// through the lane.

import {expect, test, vi} from 'vitest';

import {blockConvLane} from '../../utils/lanes/blockconv';

const HISTORY = {
  cfg: {
    align: false,
    autolink: false,
    content: 'plain',
    conv: 'heading',
    decor: false,
    deleteHeld: false,
    endBold: false,
    endInsert: false,
    endNote: true,
    endScope: 'node',
    firstBlock: true,
    from: 'paragraph',
    hashtag: false,
    highlighter: 'none',
    parentXform: 'none',
    pxScope: 'composer',
    relxform: 'bang',
    replacement: 'none',
    rxScope: 'all',
    scope: 'composer',
    untouched: 'paragraph',
    via: 'paragraph',
    xformScope: 'composer',
  },
  gc: false,
  ids: [22, 11],
  lane: 'blockconv',
  seed: 315700007,
};

for (const gc of [false, true]) {
  test(`the value set on the composed node as the composition ends stays off other lines (gc ${gc ? 1 : 0})`, async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let findings;
    try {
      findings = await blockConvLane.run({...HISTORY, gc} as never);
    } finally {
      spy.mockRestore();
    }
    expect(findings.map(f => f.cls)).toEqual([]);
  }, 60_000);
}
