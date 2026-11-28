/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment jsdom

// While A composes in another line (its composition ended from a mutation
// listener, in an update it queues), A's delete of "ine " and B's
// overlapping delete of "ne t", applied inside the same update (a provider
// applying it there), leave A and its document apart: A shows "eight nien"
// (only B's delete), the document "eight n" (both, with stale bounds, "en"
// lost too), and A's later "#" is lost from the document
// (https://github.com/meta/lexical/issues/9836). The same history without the
// composition converges (ListenerEditBesideOverlappingDelete.test.ts). Found
// by a generator run, reduced.

import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setCompositionKey,
  $setSelection,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $selectIn,
  expectConverged,
  freshReader,
  setup,
} from '../../utils/harness';

describe.each([false, true])(
  'a local delete overlapping a remote one applied in the same update while composing, gc %s',
  gc => {
    test.fails('is stored as the editor shows it', async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('aa bb cc')),
            $createParagraphNode().append($createTextNode('eight nine ten')),
          ),
        {gc, ids: [1, 2, 3]},
      );
      const {a, b} = t;
      const host = document.createElement('div');
      host.contentEditable = 'true';
      document.body.append(host);
      a.editor.setRootElement(host);
      let composed = '';
      a.update(() => {
        const text = $getRoot().getAllTextNodes()[0];
        text.select(1, 1);
        composed = text.getKey();
        $setCompositionKey(composed);
      });
      await t.sync();
      // The composition ends from a mutation listener, in an update it
      // queues.
      let released = false;
      const stopRelease = a.editor.registerMutationListener(
        TextNode,
        mutations => {
          if (!released && mutations.size > 0) {
            released = true;
            a.editor.update(() => {
              $setCompositionKey(null);
              const text = $getNodeByKey(composed);
              if ($isTextNode(text) && text.isAttached()) {
                text.getWritable();
              }
            });
          }
        },
        {skipInitialization: true},
      );
      try {
        t.offline();
        // B deletes "ne t"; A deletes "ine " and applies B's change inside
        // the same update, while composing in the first line.
        b.update(() => {
          $selectIn([1], 8, 12).removeText();
          $setSelection(null);
        });
        const remote = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc));
        a.update(() => {
          $selectIn([1], 7, 11).removeText();
          Y.applyUpdate(a.doc, remote, 'provider');
          $selectIn([1], 9);
        });
        await Promise.resolve();
        await t.sync();
        await t.sync();
        stopRelease();
        a.update(() => {
          const last = $getRoot().getLastChildOrThrow();
          const text = $isElementNode(last) ? last.getLastDescendant() : null;
          if ($isTextNode(text)) {
            text.setTextContent(text.getTextContent() + '#');
          }
        });
        await t.sync();
        const fresh = await freshReader(a);
        const stored = fresh.describe();
        fresh.stop();
        expect(a.describe()).toBe(
          'paragraph("aa bb cc") / paragraph("eight nen#")',
        );
        expect(stored).toBe(a.describe());
        await expectConverged([a, b, t.c]);
      } finally {
        stopRelease();
        host.remove();
      }
    });
  },
);
