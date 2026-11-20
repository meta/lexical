/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// As RefusedFollowUpValueReplies, with both peers answering.
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
} from '@lexical/list';
import {
  $createTextNode,
  $getRoot,
  COLLABORATION_TAG,
  type ElementNode,
} from 'lexical';
import {expect, test, vi} from 'vitest';

import {setup} from '../../utils/harness';

// Replies scheduled (in a microtask or a timer) and not run yet.
let pending = 0;
function later(mode: 'microtask' | 'timer', reply: () => void): void {
  pending++;
  const task = () => {
    pending--;
    reply();
  };
  if (mode === 'microtask') {
    queueMicrotask(task);
  } else {
    setTimeout(task, 0);
  }
}
/**
 * Waits until no reply is scheduled for a few turns of the event loop in a
 * row, however long each reply takes (a fixed delay can sample a chain of
 * replies before it reaches its fuse).
 */
async function drain(): Promise<void> {
  let quiet = 0;
  for (let turn = 0; turn < 10_000 && quiet < 3; turn++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    quiet = pending === 0 ? quiet + 1 : 0;
  }
  expect(pending, 'every scheduled reply ran').toBe(0);
}

for (const mode of ['nested', 'microtask', 'timer'] as const)
  for (const ids of [
    [1, 2],
    [2, 1],
  ])
    test(`two peers answer terminal ${mode} ids=${ids}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createListNode('number').append(
              $createListItemNode().append($createTextNode('one')),
              $createListItemNode().append(
                $createListNode('bullet').append(
                  $createListItemNode().append($createTextNode('nested')),
                ),
              ),
            ),
          ),
        {ids},
      );
      const counts = [0, 0];
      let active = true;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const stops = t.peers.map((p, i) =>
        p.editor.registerUpdateListener(({tags, editorState}) => {
          const nums = editorState.read(() =>
            ($getRoot().getFirstChildOrThrow() as ElementNode)
              .getChildren()
              .map(item => ($isListItemNode(item) ? item.getValue() : -1)),
          );
          if (!tags.has(COLLABORATION_TAG) || nums[1] !== 2 || counts[i] >= 20)
            return;
          counts[i]++;
          const update = () => {
            if (active)
              p.editor.update(
                () =>
                  (
                    (
                      $getRoot().getFirstChildOrThrow() as ElementNode
                    ).getChildAtIndex(1) as ElementNode
                  ).clear(),
                {discrete: true, tag: 'block-id-repair'},
              );
          };
          if (mode === 'nested') {
            update();
          } else {
            later(mode, update);
          }
        }),
      );
      try {
        t.offline();
        for (const [i, p] of t.peers.entries())
          p.update(() =>
            ($getRoot().getFirstChildOrThrow() as ElementNode).append(
              $createListItemNode().append($createTextNode(`peer${i}`)),
            ),
          );
        const clocks = t.peers.map(p => p.doc.store.getClock(p.doc.clientID));
        await t.sync();
        await drain();
        expect(t.peers.map(p => p.errors)).toEqual([[], []]);
        expect(t.peers.map(p => p.doc.store.getClock(p.doc.clientID))).toEqual(
          clocks,
        );
        for (const p of t.peers) {
          expect(p.doc.store.pendingStructs).toBe(null);
          expect(p.doc.store.pendingDs).toBe(null);
        }
        expect(
          Math.min(...counts),
          'both listeners actually answered',
        ).toBeGreaterThan(0);
        expect(Math.max(...counts), 'no terminal re-read loop').toBeLessThan(
          20,
        );
      } finally {
        active = false;
        stops.forEach(s => s());
        t.peers.forEach(p => p.stop());
        warn.mockRestore();
      }
    });
