/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// Clients take turns (they sync after every step): B types " q18" without a
// comment after a word it commented c14, comments it c18 and deletes it;
// A edits and deletes around it; B undoes the delete. " q18" comes back
// without c14, which it never had: a collapse that kept only a later null,
// whose run had lost its opener, and not c14's end before it, gave it c14.

import {$addMarkID, $getNodeMarkIDs} from '@lexical/mark';
import {
  $createTextNode,
  $getRoot,
  $setSelection,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {
  $block,
  $locateIn,
  $p,
  $selectIn,
  expectConverged,
  type Peer,
  setup,
} from '../../utils/harness';
import {prepareMarkState as prepare} from '../../utils/sizeOps';

function $plain(at: number, text: string): void {
  const [node, off] = $locateIn($block([0]), at);
  if (off === 0) {
    node.insertBefore($createTextNode(text));
  } else if (off === node.getTextContentSize()) {
    node.insertAfter($createTextNode(text));
  } else {
    node.splitText(off)[1].insertBefore($createTextNode(text));
  }
  $setSelection(null);
}

/** The comment ids of each character of `word` in the first line. */
function idsOn(peer: Peer, word: string): string[][] {
  const cs = peer.read(() =>
    ($block([0]).getAllTextNodes() as TextNode[]).flatMap(n =>
      Array.from(
        n.getTextContent(),
        c => [c, [...$getNodeMarkIDs(n as LexicalNode)].sort()] as const,
      ),
    ),
  );
  const at = cs
    .map(c => c[0])
    .join('')
    .indexOf(word);
  expect(at).toBeGreaterThanOrEqual(0);
  return cs.slice(at, at + word.length).map(c => [...c[1]]);
}

for (const ids of [
  [1, 3, 2],
  [3, 1, 2],
]) {
  test(`an undo brings a plain word back without the comment of the word before it (${ids})`, async () => {
    const t = await setup(
      () => $getRoot().append($p('aaaa bbb ccc ddd eeee'), $p('tail line')),
      {ids, prepare},
    );
    const mark = async (p: Peer, id: string, from: number, to: number) => {
      p.update(() => {
        $addMarkID(id, $selectIn([0], from, to));
        $setSelection(null);
      });
      await t.sync();
    };
    const del = async (p: Peer, from: number, to: number) => {
      p.update(() => {
        $selectIn([0], from, to).removeText();
        $setSelection(null);
      });
      await t.sync();
    };
    const insert = async (p: Peer, at: number, text: string) => {
      p.update(() => $plain(at, text));
      await t.sync();
    };
    await mark(t.a, 'c7', 0, 8);
    await mark(t.b, 'c14', 0, 4);
    await insert(t.b, 4, ' q17');
    await mark(t.b, 'c17', 5, 8);
    await del(t.b, 4, 8);
    await insert(t.b, 4, ' q18');
    expect(idsOn(t.b, 'q18')).toEqual([[], [], []]);
    await mark(t.b, 'c18', 5, 8);
    await del(t.b, 4, 8);
    await insert(t.a, 2, 'X15');
    await del(t.a, 4, 12);
    t.a.update(() => {
      $selectIn([0], 1).insertText('k18');
      $setSelection(null);
    });
    await t.sync();
    await del(t.a, 6, 7);
    t.b.undo();
    await t.sync();
    await expectConverged(t.peers);
    expect(t.a.read(() => $block([0]).getTextContent())).toBe(
      'ak18aX q18ccc ddd eeee',
    );
    expect(idsOn(t.a, 'ak18a')).toEqual(Array(5).fill(['c14', 'c7']));
    expect(idsOn(t.a, ' q18').some(held => held.includes('c14'))).toBe(false);
    t.peers.forEach(p => p.stop());
  });
}
