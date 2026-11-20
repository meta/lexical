/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$addMarkID, $getNodeMarkIDs} from '@lexical/mark';
import {
  $createTextNode,
  $getRoot,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $p,
  $selectIn,
  expectConverged,
  type Peer,
  setup,
} from '../utils/harness';
import {prepareMarkState as prepare} from '../utils/sizeOps';

function line(peer: Peer, i: number): string {
  return peer.read(() =>
    ($block([i]).getAllTextNodes() as TextNode[])
      .flatMap(n => {
        const ids = $getNodeMarkIDs(n as LexicalNode);
        return n
          .getTextContent()
          .split(' ')
          .filter(w => w !== '')
          .map(w => (ids.length > 0 ? `${w}[${ids.join(',')}]` : w));
      })
      .join(' '),
  );
}

function $insertPlainAt(off: number, text: string) {
  for (const node of $block([0]).getAllTextNodes() as TextNode[]) {
    if (off > 0 && off < node.getTextContentSize()) {
      const [, tail] = node.splitText(off);
      tail.insertBefore($createTextNode(text));
      return;
    }
    off -= node.getTextContentSize();
  }
  throw new Error(`no text node holds offset ${off} inside it`);
}

// A comments "Kilo" and B comments "bb"; A types plain "X" inside "Kilo" in
// one write, and both sync. Then A undoes it while B, having seen it,
// deletes past the comment's end ("o", then the space or " bb"), next to a
// gap that holds the other comment's items (a delete collapsed such a gap
// before D86; it now keeps every format item it leaves). The comment
// ends where it ended on every client. Main passes; #9562 (parked) wrote a
// second null of A's own right after the comment's end, the collapse kept
// it (the key's last item) and dropped the comment's end, and A's undo
// removed the null: the comment covered the rest of the document.
describe('@lexical/y undo of one write inside a comment its author opened ‖ a delete past its end across another comment', () => {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    for (const variant of ['o then space', 'o then " bb"']) {
      test(`the comment ends where it ended (B deletes ${variant}, ids ${ids})`, async () => {
        const t = await setup(
          () => $getRoot().append($p('aa Kilo bb cc dd'), $p('tail line')),
          {ids, prepare},
        );
        t.a.update(() => void $addMarkID('c1', $selectIn([0], 3, 7)));
        t.b.update(() => void $addMarkID('c2', $selectIn([0], 8, 10)));
        await t.sync();
        t.a.update(() => $insertPlainAt(6, 'X'));
        await t.sync();
        t.offline();
        t.a.undo();
        t.b.update(() => void $selectIn([0], 7, 8).removeText());
        if (variant === 'o then space') {
          t.b.update(() => void $selectIn([0], 7, 8).removeText());
        } else {
          t.b.update(() => void $selectIn([0], 7, 10).removeText());
        }
        await t.sync();
        await expectConverged(t.peers);
        expect(t.a.read(() => $block([0]).getTextContent())).toBe(
          variant === 'o then space' ? 'aa Kilbb cc dd' : 'aa Kil cc dd',
        );
        expect(line(t.a, 0)).toBe(
          variant === 'o then space'
            ? 'aa Kil[c1] bb[c2] cc dd'
            : 'aa Kil[c1] cc dd',
        );
        expect(line(t.a, 1)).toBe('tail line');
      });
    }
  }
});
