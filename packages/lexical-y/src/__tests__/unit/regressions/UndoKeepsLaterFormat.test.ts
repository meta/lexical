/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// Three clients, synced after every step: one types, another deletes text
// next to it, the first makes a range italic, and the second undoes its
// delete. The undo brings back the deleted character and must keep the
// italic a collaborator gave the text around it afterwards (a fix that ends
// the runs an undo brings back where they ended at the delete would cut it).
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {$block, $selectIn, expectConverged, setup} from '../../utils/harness';
import {prepareMarkState as prepare} from '../../utils/sizeOps';

const words = [
  ['w0abc', 'w1abc', 'w2ab', 'w3ab', 'w4ab'],
  ['w5abc', 'w6ab', 'w7a', 'w8ab', 'w9abcd', 'w10abcd'],
];
const preFmt = [
  [8, 2, 0, 1, 0],
  [1, 0, 0, 0, 0, 0],
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

test("an undo of a delete keeps a collaborator's later italic on live text", async () => {
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
    {ids: [3, 2, 1], prepare},
  );
  for (const p of t.peers) p.binding.undoManager?.clear();
  t.peers[0].update(() => $plain(0, 11, 'xq2'));
  t.peers[1].update(() => void $selectIn([0], 6, 19).removeText());
  t.peers[1].update(() => void $selectIn([0], 6, 7).removeText());
  t.peers[0].update(() => void $selectIn([0], 0, 10).formatText('italic'));
  t.peers[1].undo();
  await t.sync();
  await expectConverged(t.peers);
  // Peer 0 made "w0abc " .. "3ab " italic (step 4) while it was live; peer 1's undo
  // only brings back the one character it deleted at step 3. Main and a build with no
  // collapse at all agree: the italic stays where peer 0 put it.
  const runs = t.peers[0].read(() =>
    ($block([0]).getAllTextNodes() as TextNode[]).map(n => [
      n.getTextContent(),
      n.getFormat(),
    ]),
  );
  expect(runs).toEqual([
    ['w0abc ', 10],
    [' ', 2],
    ['w3ab', 3],
    [' ', 1],
    ['w4ab', 0],
  ]);
});
