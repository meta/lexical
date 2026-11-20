/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// An app's update listener that answers every refresh, or every
// collaboration-tagged commit, with a follow-up the binding does not write
// (here BlockIdExtension's tag on an inserted paragraph) sets off a re-read,
// whose refresh sets off the listener again. The binding cuts that loop off
// after a few re-reads in a row (MAX_REREADS), on one or both peers, in both
// client id orders, with discrete and batched updates (#9634 review).
import {$createListItemNode, $createListNode} from '@lexical/list';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
  COLLABORATION_TAG,
  type ElementNode,
} from 'lexical';
import {expect, test, vi} from 'vitest';

import {freshReader, setup} from '../../utils/harness';

// A fuse for the test itself: the binding stops the loop well before it.
const FUSE = 20;

for (const ids of [
  [1, 2],
  [2, 1],
])
  for (const both of [false, true])
    for (const batch of [false, true])
      for (const mode of ['refresh', 'collaboration'] as const) {
        test(`listener refusal cycle mode=${mode} batch=${batch} both=${both} ids=${ids}`, async () => {
          const t = await setup(
            () =>
              $getRoot().append(
                $createListNode('number').append(
                  $createListItemNode().append($createTextNode('one')),
                ),
              ),
            {ids},
          );
          const counts = t.peers.map(() => 0);
          const stops: (() => void)[] = [];
          const warning = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => {});
          try {
            t.peers.forEach((p, i) => {
              if (i > 0 && !both) return;
              stops.push(
                p.editor.registerUpdateListener(({tags}) => {
                  const trigger =
                    mode === 'refresh'
                      ? tags.has('lexical-y-refresh')
                      : tags.has(COLLABORATION_TAG) &&
                        !tags.has('block-id-repair');
                  if (!trigger || counts[i] >= FUSE) return;
                  counts[i]++;
                  p.editor.update(
                    () => {
                      $getRoot().append(
                        $createParagraphNode().append(
                          $createTextNode('follow-up'),
                        ),
                      );
                      $setSelection(null);
                    },
                    batch
                      ? {tag: 'block-id-repair'}
                      : {discrete: true, tag: 'block-id-repair'},
                  );
                }),
              );
            });
            const beforeClock = t.a.doc.store.getClock(t.a.doc.clientID);
            t.b.update(() => {
              ($getRoot().getFirstChildOrThrow() as ElementNode).append(
                $createListItemNode().append($createTextNode('two')),
              );
            });
            await t.sync();
            await new Promise(resolve => setTimeout(resolve, 30));
            expect(
              t.a.doc.store.getClock(t.a.doc.clientID),
              'no writes on remote apply',
            ).toBe(beforeClock);
            // 20 is a harness fuse, not an accepted implementation bound.
            expect(
              Math.max(...counts),
              'listener-generated refusal chain must terminate before fuse',
            ).toBeLessThan(FUSE);
            expect(
              Math.max(...counts),
              'same bound as MAX_REREADS plus initial read/refresh',
            ).toBeLessThanOrEqual(5);
            for (const p of t.peers) {
              expect(p.doc.store.pendingStructs).toBe(null);
              expect(p.doc.store.pendingDs).toBe(null);
              const fresh = await freshReader(p);
              try {
                expect(p.json()).toEqual(fresh.json());
              } finally {
                fresh.stop();
              }
            }
          } finally {
            stops.forEach(s => s());
            t.peers.forEach(p => p.stop());
            warning.mockRestore();
          }
        });
      }
