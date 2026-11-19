/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The follow-up check compares a container whose block ids are settled after
// the write too, without those ids (R16B-F1). It skipped such a container:
// a follow-up (here BlockIdExtension's repair tag, without transforms) that
// set NodeState on a paragraph stored without a marker and gave another
// block a repeated id in the same update kept the state on its author, and
// no peer or fresh reader showed it.

import '../utils/blockIdsEnv';

import {blockIdState} from '@lexical/extension';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $setSelection,
  $setState,
  createState,
  type ElementNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {
  $block,
  flush,
  freshReader,
  type Peer,
  setup,
  WidgetNode,
} from '../utils/harness';

delete process.env.LEXICAL_Y_BLOCK_ID;

const state = createState('settlingProbe', {
  parse: v => (typeof v === 'string' ? v : ''),
});

/** A peer's JSON, NodeState keys in order. */
function json(p: Peer): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) {
      return x.map(sort);
    }
    if (x !== null && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) {
        out[k] = sort(o[k]);
      }
      return out;
    }
    return x;
  };
  return JSON.stringify(sort(p.json()));
}

for (const ids of [
  [1, 2],
  [2, 1],
]) {
  test(`a follow-up's state on a markerless paragraph with a repeated id given in it (client ids ${ids})`, async () => {
    const t = await setup(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('Title')),
          $createParagraphNode().append($createTextNode('one')),
          $createParagraphNode().append($createTextNode('end')),
        );
      },
      {ids},
    );
    // A paragraph left without a marker: removed by A while B types in it.
    t.offline();
    t.a.update(() => {
      $getRoot().getLastChild()!.remove();
      $block([1]).insertAfter($create(WidgetNode));
      $setSelection(null);
    });
    t.b.update(() => {
      ($getRoot().getLastChild() as ElementNode).selectEnd().insertText(' XX');
      $setSelection(null);
    });
    await t.sync();
    t.b.editor.update(
      () => {
        $setState($getRoot().getLastChild()!, state, 'v1');
        $setState(
          $block([1]),
          blockIdState,
          $getState($getRoot().getFirstChild()!, blockIdState),
        );
        $setSelection(null);
      },
      {discrete: true, skipTransforms: true, tag: 'block-id-repair'},
    );
    await flush();
    const f = await freshReader(t.b);
    await t.sync();
    try {
      expect(json(t.b)).toBe(json(f));
      expect(json(t.b)).toBe(json(t.a));
    } finally {
      [...t.peers, f].forEach(p => p.stop());
    }
  });
}
