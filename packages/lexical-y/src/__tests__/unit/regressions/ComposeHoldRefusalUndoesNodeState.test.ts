/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A composes `abc` in a numbered-list item; B types R in it, which A's hold
// keeps back. A local edit of A's moves that item and, in the same update,
// sets NodeState on the text composed in and on a line it does not move.
// The edit is refused (`'held-composition'`): every non-character change in
// it, the NodeState included, is undone, and A shows what the document
// holds, as every peer and a fresh reader do.

import {
  $createListItemNode,
  $createListNode,
  type ListItemNode,
  type ListNode,
} from '@lexical/list';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $setCompositionKey,
  $setSelection,
  $setState,
  createState,
  type TextNode,
} from 'lexical';
import {expect, onTestFinished, test} from 'vitest';

import {freshReader, setup} from '../../utils/harness';

const note = createState('note', {
  parse: (v: unknown) => (typeof v === 'string' ? v : ''),
});

const $text = (start: string): TextNode =>
  $getRoot()
    .getAllTextNodes()
    .find(n => n.getTextContent().startsWith(start))!;

for (const gc of [false, true]) {
  for (const ids of [
    [1, 2, 3],
    [3, 2, 1],
  ]) {
    test(`a refused edit undoes the NodeState it set (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createListNode('number').append(
              $createListItemNode().append($createTextNode('abc')),
              $createListItemNode().append($createTextNode('tail')),
            ),
            $createParagraphNode().append($createTextNode('separator')),
          );
        },
        {gc, ids},
      );
      const {a, b} = t;
      const host = document.createElement('div');
      host.contentEditable = 'true';
      document.body.append(host);
      a.editor.setRootElement(host);
      host.focus();
      onTestFinished(() => {
        a.editor.setRootElement(null);
        host.remove();
        t.peers.forEach(p => p.stop());
      });
      a.update(() => {
        const n = $text('a');
        n.select(1, 1);
        $setCompositionKey(n.getKey());
      });
      await t.sync();
      b.update(() => {
        $text('a').spliceText(1, 0, 'R');
        $setSelection(null);
      });
      await t.sync();
      expect(a.describe()).not.toContain('R');
      const before = a.warnings.length;
      a.update(() => {
        $setState($text('a'), note, 'composed');
        $setState($text('separator'), note, 'elsewhere');
        const first = $getRoot().getFirstChildOrThrow() as ListNode;
        first.append(first.getFirstChildOrThrow() as ListItemNode);
      });
      await t.sync();
      expect(
        a.warnings.slice(before).filter(w => w.includes('line being composed')),
      ).toHaveLength(1);
      const states = (peer: typeof a) =>
        peer.read(() =>
          $getRoot()
            .getAllTextNodes()
            .map(n => $getState(n, note))
            .filter(v => v !== ''),
        );
      expect(states(a)).toEqual([]);
      a.update(() => $setCompositionKey(null));
      await t.sync();
      const fresh = await freshReader(a);
      onTestFinished(() => fresh.stop());
      expect(states(a)).toEqual([]);
      expect(states(b)).toEqual([]);
      expect(states(fresh)).toEqual([]);
      expect(fresh.describe()).toBe(b.describe());
      expect(a.describe()).toBe(b.describe());
    });
  }
}
