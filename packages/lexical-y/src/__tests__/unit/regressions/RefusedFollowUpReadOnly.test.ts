/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// As RefusedFollowUpLoops, on a client that is read only (an older
// schemaVersion than the document's): the loop is cut off, nothing is
// written, and the editor shows the document (#9634 review).
import {$createListItemNode, $createListNode} from '@lexical/list';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  COLLABORATION_TAG,
  type ElementNode,
} from 'lexical';
import {expect, test, vi} from 'vitest';

import {createYDoc} from '../../..';
import {createBoundEditor, NODES} from '../../utils/harness';

for (const gc of [false, true])
  for (const batch of [false, true])
    for (const mode of ['refresh', 'collaboration'] as const)
      test(`read-only refused listener gc=${gc} batch=${batch} mode=${mode}`, async () => {
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
        expect(a.binding.status).toBe('readonly');
        let n = 0;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const stop = a.editor.registerUpdateListener(({tags}) => {
          const trigger =
            mode === 'refresh'
              ? tags.has('lexical-y-refresh')
              : tags.has(COLLABORATION_TAG) && !tags.has('block-id-repair');
          if (!trigger || n >= 20) return;
          n++;
          a.editor.update(
            () =>
              $getRoot().append(
                $createParagraphNode().append($createTextNode('refused')),
              ),
            batch
              ? {tag: 'block-id-repair'}
              : {discrete: true, tag: 'block-id-repair'},
          );
        });
        try {
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
          await new Promise(r => setTimeout(r, 30));
          expect(errors).toEqual([]);
          expect(
            adoc.store.getClock(adoc.clientID),
            'no write on read-only remote apply',
          ).toBe(before);
          expect(
            n,
            'refusal chain terminates before harness fuse',
          ).toBeLessThan(20);
          expect(a.editor.getEditorState().toJSON()).toEqual(
            b.editor.getEditorState().toJSON(),
          );
        } finally {
          stop();
          stopA();
          stopB();
          warn.mockRestore();
        }
      });
