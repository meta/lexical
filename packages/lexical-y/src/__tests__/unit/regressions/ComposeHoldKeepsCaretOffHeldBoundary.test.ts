/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A remote change must not leave the caret of a composition where Lexical's
// selection normalization moves it, and the composition, to another node at
// the composer's next update. B links "four fi"; A composes inside the link
// (offset 6). B replaces the link with one that reaches into the next line
// (the hold keeps the old link around the composed text), then deletes the
// character after A's caret: the old link ended at A's caret, before plain
// text, and A's next update moved the composition key to that text, while
// main (which shows the new link) kept it. The change is read at once there,
// as main reads it.
import {$toggleLink} from '@lexical/link';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setCompositionKey,
  $setSelection,
  type ElementNode,
} from 'lexical';
import {expect, onTestFinished, test} from 'vitest';

import {$selectIn, freshReader, setup} from '../../utils/harness';

for (const gc of [false, true])
  for (const target of ['left'])
    for (const from of [0, 1])
      for (const ids of [
        [1, 2, 3],
        [3, 2, 1],
      ]) {
        test(`a remote change that would leave the composing caret on a link boundary keeps the composition where it is (target ${target}, from ${from}, ids ${ids}, gc ${gc})`, async () => {
          const t = await setup(
            () => {
              $getRoot().append(
                ...['zero start', 'four five six', 'seven eight'].map(s =>
                  $createParagraphNode().append($createTextNode(s)),
                ),
              );
            },
            {gc, ids},
          );
          await t.sync();
          const {a, b} = t;
          const host = document.createElement('div');
          host.contentEditable = 'true';
          document.body.append(host);
          a.editor.setRootElement(host);
          onTestFinished(() => {
            a.editor.setRootElement(null);
            host.remove();
            t.peers.forEach(p => p.stop());
          });
          b.update(() => {
            $selectIn([1], 0, 7);
            $toggleLink('https://l.test/2');
            $setSelection(null);
          });
          await t.sync();
          let key = '';
          a.update(() => {
            const texts = (
              $getRoot().getChildAtIndex(1) as ElementNode
            ).getAllTextNodes();
            const n = target === 'left' ? texts[0] : texts[texts.length - 1];
            key = n.getKey();
            n.select(6, 6);
            $setCompositionKey(key);
          });
          const old = a.editor.getElementByKey(key)!.firstChild!;
          const snapshot = () =>
            a.read(() => {
              const sel = $getSelection();
              return {
                caret: $isRangeSelection(sel)
                  ? [sel.anchor.key, sel.anchor.offset]
                  : null,
                dom: old.isConnected,
                key: a.editor._compositionKey,
                tree: a.describe(),
              };
            });
          a.update(() => {});
          expect(a.editor._compositionKey).toBe(key);
          const before = snapshot();
          b.update(() => {
            $selectIn([from], from === 0 ? 2 : 0, from === 0 ? 2 : 0);
            const sel = $getSelection();
            if ($isRangeSelection(sel)) {
              const last = (
                $getRoot().getChildAtIndex(2) as ElementNode
              ).getAllTextNodes()[0];
              sel.focus.set(last.getKey(), 1, 'text');
            }
            $toggleLink('https://l.test/1');
            $setSelection(null);
          });
          await t.sync();
          b.update(() => {
            $selectIn([1], 6, 7).removeText();
            $setSelection(null);
          });
          await t.sync();
          a.update(() => {});
          const after = snapshot();
          expect(after.key).toBe(before.key);
          expect(old.isConnected).toBe(true);
          a.update(() => {
            $setCompositionKey(null);
          });
          await t.sync();
          expect((await freshReader(a)).describe()).toBe(a.describe());
        });
      }
