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
// member (a comment id). B formats "one two" and C formats "two three a … j"
// with the same key at the same time, so C's run nests over the end of B's; C bolds ten letters
// inside it (its end is then found through the document's index of ends).
// While A composes at the end of the line, one change deletes C's run
// and formats across the line break before it, so A's line is read again
// with the hold keeping the deleted run. The read must pair the kept opener
// with its kept end as A's writes do: when it did not (a kept end counted as
// gone while reading), the end of B's run cut C's run short after "two",
// and A's next write in the line warned `self-check: format w:link at N`.

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

for (const kind of ['link', 'color', 'comment'] as const) {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      test(`a line read again while its hold keeps a deleted ${kind} run shows that run as it showed (gc ${gc}, ids ${ids})`, async () => {
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
          const n = $getNodeByKey(key) as TextNode;
          n.setTextContent(n.getTextContent() + 'Y');
        });
        await t.sync();
        expect(a.warnings.filter(w => /self-check/.test(w))).toEqual([]);
        await expectConverged(t.peers);
        const fresh = await freshReader(a);
        expect(fresh.describe()).toBe(a.describe());
      });
    }
  }
}
