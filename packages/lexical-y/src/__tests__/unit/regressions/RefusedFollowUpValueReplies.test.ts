/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// An app's update listener that answers a collaboration-tagged commit, when
// a nested list item shows `value` 2, by emptying that item in a follow-up
// the binding does not write (nested in the listener, in a microtask or in a
// timer): the chain of replies stops (#9632 review). And a list whose own
// transform adds an item on every run keeps its numbering when its change is
// read again.
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  ListNode,
} from '@lexical/list';
import {
  $create,
  $createTextNode,
  $getEditor,
  $getRoot,
  COLLABORATION_TAG,
  type ElementNode,
  type LexicalEditor,
} from 'lexical';
import {expect, test, vi} from 'vitest';

import {freshReader, NODES, setup} from '../../utils/harness';

const numbers = (e: LexicalEditor) =>
  e.getEditorState().read(() =>
    (
      $getRoot()
        .getChildren()
        .find(n => n instanceof ListNode) as ElementNode
    )
      .getChildren()
      .map(item => ($isListItemNode(item) ? item.getValue() : -1)),
  );

for (const mode of ['nested', 'microtask', 'timer'] as const)
  for (const ids of [
    [1, 2],
    [2, 1],
  ])
    test(`value-sensitive ${mode} listener terminates ids=${ids}`, async () => {
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
      let n = 0;
      let active = true;
      let jobs = 0;
      const events: unknown[] = [];
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const stop = t.a.editor.registerUpdateListener(({tags, editorState}) => {
        const ns = editorState.read(() =>
          ($getRoot().getFirstChildOrThrow() as ElementNode)
            .getChildren()
            .map(item => ($isListItemNode(item) ? item.getValue() : -1)),
        );
        if (!tags.has(COLLABORATION_TAG) || ns[1] !== 2 || n >= 20) return;
        events.push({ns, tags: [...tags]});
        n++;
        const update = () => {
          if (!active) return;
          t.a.editor.update(
            () =>
              (
                (
                  $getRoot().getFirstChildOrThrow() as ElementNode
                ).getChildAtIndex(1) as ElementNode
              ).clear(),
            {discrete: true, tag: 'block-id-repair'},
          );
        };
        if (mode === 'nested') update();
        else {
          jobs++;
          const task = () => {
            jobs--;
            update();
          };
          if (mode === 'microtask') {
            queueMicrotask(task);
          } else {
            setTimeout(task, 0);
          }
        }
      });
      try {
        const clock = t.a.doc.store.getClock(t.a.doc.clientID);
        t.b.update(() =>
          ($getRoot().getFirstChildOrThrow() as ElementNode).append(
            $createListItemNode().append($createTextNode('two')),
          ),
        );
        await t.sync();
        // Until no reply is scheduled for a few turns in a row, however long
        // each takes (a fixed delay can sample the chain before its fuse).
        let quiet = 0;
        for (let turn = 0; turn < 10_000 && quiet < 3; turn++) {
          await new Promise(resolve => setTimeout(resolve, 0));
          quiet = jobs === 0 ? quiet + 1 : 0;
        }
        expect(
          t.a.doc.store.getClock(t.a.doc.clientID),
          'no remote writes',
        ).toBe(clock);
        expect(t.a.doc.store.pendingStructs).toBe(null);
        expect(t.a.doc.store.pendingDs).toBe(null);
        expect(t.peers.map(p => p.errors)).toEqual([[], []]);
        expect(n, 'listener actually exercised').toBeGreaterThan(0);
        expect(n, 'no listener-driven loop; 20 is a test fuse').toBeLessThan(
          20,
        );
        expect(jobs).toBe(0);
        // This oracle measures termination. Main's stale numbering is
        // independently covered by the prior Freshness matrix (#9632).
      } finally {
        active = false;
        stop();
        t.peers.forEach(p => p.stop());
        warn.mockRestore();
      }
    });

let looping: LexicalEditor | null = null;
let runs = 0;
class GrowingNumberedList extends ListNode {
  $config() {
    return this.config('review-growing-numbered', {
      $transform: (node: GrowingNumberedList) => {
        if ($getEditor() === looping) {
          runs++;
          node.append($createListItemNode().append($createTextNode('more')));
        }
      },
      extends: ListNode,
    });
  }
}
for (const start of [1, 7])
  test(`terminal shape re-read preserves numbering start=${start}`, async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $create(GrowingNumberedList)
            .setListType('number')
            .setStart(start)
            .append($createListItemNode().append($createTextNode('one'))),
        ),
      {nodes: [...NODES, GrowingNumberedList]},
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      looping = t.a.editor;
      runs = 0;
      const clock = t.a.doc.store.getClock(t.a.doc.clientID);
      t.b.update(() =>
        ($getRoot().getFirstChildOrThrow() as ElementNode).append(
          $createListItemNode().append($createTextNode('two')),
        ),
      );
      await t.sync();
      await new Promise(r => setTimeout(r, 20));
      looping = null;
      const fresh = await freshReader(t.a);
      try {
        expect(runs).toBeLessThanOrEqual(5);
        expect(t.a.doc.store.getClock(t.a.doc.clientID)).toBe(clock);
        expect(
          numbers(t.a.editor),
          'derived values after terminal structural re-read',
        ).toEqual([start, start + 1]);
        expect(t.a.json()).toEqual(fresh.json());
      } finally {
        fresh.stop();
      }
    } finally {
      looping = null;
      t.peers.forEach(p => p.stop());
      warn.mockRestore();
    }
  });
