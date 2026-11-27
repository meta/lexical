/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// As RefusedFollowUpValueReplies, on a client that is read only (an older
// schemaVersion than the document's), with `gc` on and off.
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
} from '@lexical/list';
import * as Y from '@y/y';
import {
  $createTextNode,
  $getRoot,
  COLLABORATION_TAG,
  type ElementNode,
} from 'lexical';
import {expect, test, vi} from 'vitest';

import {createYDoc} from '../../..';
import {createBoundEditor, NODES} from '../../utils/harness';

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

for (const gc of [false, true])
  for (const mode of ['nested', 'microtask', 'timer'] as const)
    test(`readonly value-sensitive ${mode} gc=${gc}`, async () => {
      const errors: unknown[] = [];
      const bdoc = createYDoc(null, {gc});
      bdoc.clientID = 202;
      const b = createBoundEditor(bdoc, {
        namespace: 'sender',
        nodes: NODES,
        onError: e => {
          throw e;
        },
        onWarn: () => {},
        schemaVersion: 2,
        selfCheck: false,
      });
      const stopB = b.start();
      b.editor.update(
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
        {discrete: true},
      );
      b.binding.initialize();
      const adoc = createYDoc(Y.encodeStateAsUpdate(bdoc), {gc});
      adoc.clientID = 101;
      const a = createBoundEditor(adoc, {
        namespace: 'reader',
        nodes: NODES,
        onError: e => {
          errors.push(e);
        },
        onWarn: () => {},
        schemaVersion: 1,
        selfCheck: false,
      });
      const stopA = a.start();
      a.binding.initialize();
      let n = 0;
      let active = true;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const stop = a.editor.registerUpdateListener(({tags, editorState}) => {
        const nums = editorState.read(() =>
          ($getRoot().getFirstChildOrThrow() as ElementNode)
            .getChildren()
            .map(item => ($isListItemNode(item) ? item.getValue() : -1)),
        );
        if (!tags.has(COLLABORATION_TAG) || nums[1] !== 2 || n >= 20) return;
        n++;
        const update = () => {
          if (active)
            a.editor.update(
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
      });
      try {
        expect(a.binding.status).toBe('readonly');
        const before = adoc.store.getClock(adoc.clientID);
        b.editor.update(
          () =>
            ($getRoot().getFirstChildOrThrow() as ElementNode).append(
              $createListItemNode().append($createTextNode('two')),
            ),
          {discrete: true},
        );
        Y.applyUpdate(
          adoc,
          Y.encodeStateAsUpdate(bdoc, Y.encodeStateVector(adoc)),
        );
        await drain();
        expect(errors).toEqual([]);
        expect(adoc.store.getClock(adoc.clientID)).toBe(before);
        expect(adoc.store.pendingStructs).toBe(null);
        expect(adoc.store.pendingDs).toBe(null);
        expect(n, 'listener exercised').toBeGreaterThan(0);
        expect(n, 'loop before test fuse').toBeLessThan(20);
      } finally {
        active = false;
        stop();
        stopA();
        stopB();
        warn.mockRestore();
      }
    });
