/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A composing peer whose line is read again while its hold keeps a deleted
// paired run, for a wrapper (a link), a text field (a color) and a set
// member (a comment id), with another end naming the run's opener (a raw
// writer's) after the composed line, written before or after the removal.
// B formats "one two" and C formats "two three a … j" with the same key at
// the same time, so C's run nests over the end of B's; C bolds ten letters
// inside it. While A composes at the end of the line, one change deletes
// C's run (both halves, or its end only) and formats across the line break
// before it, so A's line is read again. An end that arrives outside the
// composed line can pair the opener inside it again: that line is read
// then, even with nothing of the change held in it; when it was not, A's
// next write warned `self-check: format w:link at 7` (and `p:style`,
// `s:markIds␟c1`).

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

for (const extra of ['before removal', 'after removal'] as const) {
  for (const deletion of ['both halves', 'end only'] as const) {
    for (const kind of ['link', 'color', 'comment'] as const) {
      for (const gc of [false, true]) {
        for (const ids of [
          [1, 2, 3],
          [3, 2, 1],
        ]) {
          test(`a composed line reads a run another end pairs again: that end added ${extra}, ${deletion} removed, ${kind} (gc ${gc}, ids ${ids})`, async () => {
            const t = await setup(
              () =>
                $getRoot().append(
                  $createParagraphNode().append($createTextNode('zero')),
                  $createParagraphNode().append(
                    $createTextNode('one two three a b c d e f g h i j four'),
                  ),
                  $createParagraphNode().append($createTextNode('after')),
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
            const target = (() => {
              for (
                let it = c.doc.get('lexical-y')._start;
                it !== null;
                it = it.right
              ) {
                if (
                  !it.deleted &&
                  it.content instanceof Y.ContentFormat &&
                  it.content.key === KEY[kind] &&
                  it.id.client === c.doc.clientID &&
                  !Array.isArray(it.content.value)
                )
                  return it;
              }
              throw new Error('no opener');
            })();
            const addEnd = () => {
              const root = b.doc.get('lexical-y');
              const flat = root
                .toDelta()
                .children.map(p => {
                  const insert = (p as {insert?: unknown}).insert;
                  return typeof insert === 'string' ? insert : '\u0001';
                })
                .join('');
              const at = flat.indexOf('after');
              expect(at).toBeGreaterThanOrEqual(0);
              root.format(at, 1, {
                [KEY[kind]]:
                  root.getAttr('lexical-y:5') === true
                    ? [target.id.client, target.id.clock]
                    : null,
              });
            };
            if (extra === 'before removal') {
              addEnd();
              await t.sync();
            }
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
                  it.id.client === c.doc.clientID &&
                  (deletion === 'both halves' ||
                    (Array.isArray(it.content.value) &&
                      it.content.value.length > 0))
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
            if (extra === 'after removal') {
              addEnd();
              await t.sync();
            }
            expect(a.read(() => $getNodeByKey(key)?.isAttached())).toBe(true);
            expect(a.read(() => $getRoot().getTextContent())).toContain(
              'fourX',
            );
            a.update(() => {
              $setCompositionKey(null);
              const n = $getNodeByKey(key) as TextNode;
              n.setTextContent(n.getTextContent() + 'Y');
            });
            await t.sync();
            expect(a.read(() => $getRoot().getTextContent())).toContain(
              'fourXY',
            );
            expect(a.warnings.filter(w => /self-check/.test(w))).toEqual([]);
            await expectConverged(t.peers);
            const fresh = await freshReader(a);
            expect(fresh.describe()).toBe(a.describe());
          });
        }
      }
    }
  }
}
