/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The composer's hold of a deleted paired run, from the hold to its end and
// past it: the setup of ComposeHeldWrapperRun (a link, a color or a comment
// run C wrote, nested over the end of B's run, deleted by a remote change
// while A composes in the line), then the hold ends without an edit
// (`finish`), by moving the composition to another line (`switch`), or by
// removing the composed line (`remove`), and A undoes and redoes. Every
// step converges, reads as a fresh reader does and writes no self-check
// warning (gc off and on, both id orders).

import {$toggleLink} from '@lexical/link';
import {$addMarkID} from '@lexical/mark';
import {$patchStyleText} from '@lexical/selection';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $setCompositionKey,
  $setSelection,
  type RangeSelection,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {
  $selectIn,
  expectConverged,
  freshReader,
  setup,
} from '../../utils/harness';
import {prepareMarkState as prepare} from '../../utils/sizeOps';

type Kind = 'link' | 'color' | 'comment';
const KEY: Record<Kind, string> = {
  color: 'p:style',
  comment: 's:markIds\u001fc1',
  link: 'w:link',
};
/** B's (first) or C's (second) value of `kind` over the selection. */
function $give(kind: Kind, second: boolean): void {
  const selection = $getSelection() as RangeSelection;
  if (kind === 'link') {
    $toggleLink(second ? 'https://l.test/9' : 'https://l.test/3');
  } else if (kind === 'color') {
    $patchStyleText(selection, {color: second ? 'blue' : 'red'});
  } else {
    $addMarkID('c1', selection);
  }
}

for (const release of ['finish', 'switch', 'remove'] as const) {
  for (const kind of ['link', 'color', 'comment'] as const) {
    for (const gc of [false, true]) {
      for (const ids of [
        [1, 2, 3],
        [3, 2, 1],
      ]) {
        test(`a held ${kind} run, the hold ended by ${release}, then undo and redo: converges as a fresh read (gc ${gc}, ids ${ids})`, async () => {
          const t = await setup(
            () =>
              $getRoot().append(
                $createParagraphNode().append($createTextNode('zero')),
                $createParagraphNode().append(
                  $createTextNode('one two three a b c d e f g h i j four'),
                ),
              ),
            {gc, ids, prepare},
          );
          const {a, b, c} = t;
          t.offline();
          b.update(() => {
            $selectIn([1], 0, 7);
            $give(kind, false);
            $setSelection(null);
          });
          c.update(() => {
            $selectIn([1], 4, 33);
            $give(kind, true);
            $setSelection(null);
          });
          await t.sync();
          for (let i = 0; i < 10; i++) {
            c.update(() => {
              $selectIn([1], 14 + 2 * i, 15 + 2 * i);
              ($getSelection() as RangeSelection).formatText('bold');
              $setSelection(null);
            });
          }
          await t.sync();
          // A composes at the end of "four".
          let key = '';
          a.update(() => {
            const n = $getRoot()
              .getAllTextNodes()
              .find(x => x.getTextContent().includes('four')) as TextNode;
            key = n.getKey();
            const at = n.getTextContent().length;
            n.select(at, at);
            $setCompositionKey(key);
          });
          a.update(() => {
            const n = $getNodeByKey(key) as TextNode;
            n.setTextContent(n.getTextContent() + 'X');
          });
          // One change (a raw writer's): C's run deleted, and an italic
          // from "zero" into the line, so A's line is read again.
          b.doc.transact((tr: Y.Transaction) => {
            const root = b.doc.get('lexical-y');
            const link: Y.Item[] = [];
            for (
              let it = root._start;
              it !== null;
              it = it.right as Y.Item | null
            ) {
              if (
                !it.deleted &&
                it.content instanceof Y.ContentFormat &&
                it.content.key === KEY[kind] &&
                it.id.client === c.doc.clientID
              ) {
                link.push(it);
              }
            }
            for (const it of link) {
              it.delete(tr);
            }
            root.format(2, 6, {'f:italic': true});
          }, 'raw');
          await t.sync();
          expect(a.read(() => $getRoot().getTextContent())).toContain('fourX');
          a.update(() => {
            $setCompositionKey(null);
            if (release === 'switch') {
              const next = $getRoot().getAllTextNodes()[0];
              next.select(0, 0);
              $setCompositionKey(next.getKey());
            } else if (release === 'remove') {
              $getRoot().getChildAtIndex(1)!.remove();
            }
          });
          await t.sync();
          expect(a.warnings.filter(w => /self-check/.test(w))).toEqual([]);
          await expectConverged(t.peers);
          const fresh = await freshReader(a);
          expect(fresh.describe()).toBe(a.describe());
          a.update(() => $setCompositionKey(null));
          a.undo();
          await t.sync();
          await expectConverged(t.peers);
          expect((await freshReader(a)).describe()).toBe(a.describe());
          a.binding.redo();
          await t.sync();
          await expectConverged(t.peers);
          expect((await freshReader(a)).describe()).toBe(a.describe());
        });
      }
    }
  }
}
