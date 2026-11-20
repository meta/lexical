/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// After type-and-delete cycles at one place (which a delete collapsed before
// D86; it now keeps every format item it leaves), a client types
// plain "X21" where a space was deleted; the space's deleter undoes. "X21"
// takes no comment: it never had one. A collapse that kept a run end there
// (#9617, parked) moved where the insert lands among the deleted items, and
// after the undo "X21" showed the comment c6 (reduced from a randomized
// three-peer session).

import {$addMarkID, $getNodeMarkIDs} from '@lexical/mark';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {$block, $selectIn, expectConverged, setup} from '../../utils/harness';
import {prepareMarkState as prepare} from '../../utils/sizeOps';

const words = [
  ['w0a', 'w1a', 'w2a', 'w3ab', 'w4ab'],
  ['w5abc', 'w6a', 'w7abcd', 'w8ab', 'w9a', 'w10ab'],
];
const preFmt = [
  [0, 0, 0, 0, 0],
  [0, 0, 1, 0, 0, 0],
];
function $plain(l: number, off: number, text: string) {
  for (const node of $block([l]).getAllTextNodes() as TextNode[]) {
    const size = node.getTextContentSize();
    if (off > 0 && off < size) {
      const [, tail] = node.splitText(off);
      tail.insertBefore($createTextNode(text));
      return;
    }
    if (off === size) {
      node.insertAfter($createTextNode(text));
      return;
    }
    off -= size;
  }
}

test('text typed after type-and-delete cycles takes no comment when a deleted space next to it comes back', async () => {
  const t = await setup(
    () => {
      words.forEach((ws, l) => {
        const p = $createParagraphNode();
        ws.forEach((w, i) =>
          p.append(
            $createTextNode(w + (i < ws.length - 1 ? ' ' : '')).setFormat(
              preFmt[l][i],
            ),
          ),
        );
        $getRoot().append(p);
      });
      $getRoot().append(
        $createParagraphNode().append($createTextNode('tail sentinel line')),
      );
    },
    {ids: [2, 1, 3], prepare},
  );
  for (const p of t.peers) p.binding.undoManager?.clear();
  t.peers[1].update(() => void $addMarkID('c6', $selectIn([1], 6, 9)));
  t.peers[0].update(() => $plain(1, 5, ' q7'));
  t.peers[0].update(() => void $selectIn([1], 5, 8).removeText());
  t.peers[0].update(() => $plain(1, 5, ' q8'));
  t.peers[0].update(() => void $selectIn([1], 5, 8).removeText());
  t.peers[0].update(() => $plain(1, 5, ' q10'));
  t.peers[0].update(() => void $selectIn([1], 5, 9).removeText());
  t.peers[1].update(() => $plain(1, 2, 'X6'));
  t.peers[0].update(() => void $selectIn([1], 0, 6).removeText());
  t.peers[0].update(() => $plain(1, 4, ' yz14'));
  t.peers[0].update(() => void $addMarkID('c18', $selectIn([1], 5, 10)));
  t.peers[1].update(() => void $addMarkID('c19', $selectIn([1], 11, 15)));
  t.peers[0].update(() => $plain(1, 7, 'Zz19'));
  t.offline();
  t.peers[0].undo();
  t.peers[1].update(() => void $selectIn([1], 11, 14).removeText());
  t.peers[1].update(() => void $selectIn([1], 11, 12).removeText());
  await t.sync();
  t.peers[0].update(() => $plain(1, 7, 'X21'));
  t.peers[1].undo();
  await t.sync();
  await expectConverged(t.peers);
  const x21 = t.peers[0].read(() =>
    ($block([1]).getAllTextNodes() as TextNode[])
      .filter(n => n.getTextContent().includes('X21'))
      .map(n => $getNodeMarkIDs(n as LexicalNode).join(',')),
  );
  expect(x21).toEqual(['']);
});
