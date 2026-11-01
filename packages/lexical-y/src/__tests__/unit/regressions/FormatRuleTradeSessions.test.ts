/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Three-client sessions (reduced from a view property's fresh seeds) in which a
// format reaches the sentinel line nobody formatted, made wrong by the rules
// that fixed #9671: a trade recorded as D95 (#9690). Each session pins the gc
// setting it passed with before those rules (107991 and 111874 off, 110073
// on).

import {$getNodeMarkIDs} from '@lexical/mark';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {$block, $selectIn, expectConverged, setup} from '../../utils/harness';
import {prepareMarkState as prepare} from '../../utils/sizeOps';

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

async function session(
  words: string[][],
  preFmt: number[][],
  options: {gc?: boolean; ids: number[]},
  steps: (t: Awaited<ReturnType<typeof setup>>) => Promise<void>,
) {
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
    {...options, prepare},
  );
  for (const p of t.peers) {
    p.binding.undoManager?.clear();
  }
  await steps(t);
  await expectConverged(t.peers);
  return t.peers[0].read(() =>
    ($block([2]).getAllTextNodes() as TextNode[]).map(n => [
      n.getFormat(),
      $getNodeMarkIDs(n as LexicalNode).join(','),
    ]),
  );
}

test.fails('#9690: session 107991: the sentinel line stays plain', async () => {
  const sentinel = await session(
    [
      [
        'w0ab',
        'w1abcd',
        'w2abcd',
        'w3abcd',
        'w4abcd',
        'w5abc',
        'w6abcd',
        'w7ab',
      ],
      ['w8abcd', 'w9abcd', 'w10ab', 'w11a', 'w12a', 'w13ab', 'w14a', 'w15ab'],
    ],
    [
      [0, 0, 0, 8, 2, 1, 0, 0],
      [0, 0, 0, 0, 0, 8, 8, 0],
    ],
    {gc: false, ids: [2, 1, 3]},
    async t => {
      t.peers[1].update(() => void $selectIn([1], 15, 16).removeText());
      t.peers[1].update(() => void $selectIn([1], 15, 16).removeText());
      t.peers[1].update(() => $plain(1, 43, 'xq3'));
      t.peers[0].update(() => $plain(1, 3, 'Zz6'));
      t.peers[1].update(() => void $selectIn([1], 0, 7).removeText());
      t.peers[1].update(() => void $selectIn([1], 33).insertText('k8'));
      t.peers[1].update(() => $plain(1, 13, 'Q 10'));
      t.peers[0].update(() => void $selectIn([1], 38, 41).removeText());
      t.peers[1].update(
        () => void $selectIn([1], 34, 46).formatText('underline'),
      );
      t.offline();
      t.peers[0].update(() => $plain(1, 38, 'Q 19'));
      t.peers[1].undo();
      await t.sync();
    },
  );
  expect(sentinel).toEqual([[0, '']]);
});

test.fails('#9690: session 111874: the sentinel line stays plain', async () => {
  const sentinel = await session(
    [
      ['w0ab', 'w1abc', 'w2abcd', 'w3a', 'w4a', 'w5ab', 'w6abc'],
      ['w7ab', 'w8abc', 'w9ab', 'w10abc'],
    ],
    [
      [0, 0, 0, 0, 8, 0, 0],
      [1, 2, 0, 0],
    ],
    {gc: false, ids: [3, 1, 2]},
    async t => {
      t.offline();
      t.peers[1].update(() => $plain(1, 2, 'xq17'));
      t.peers[0].update(() => void $selectIn([1], 0, 12).removeText());
      await t.sync();
      t.peers[1].update(() => void $selectIn([1], 0, 13).formatText('bold'));
      t.offline();
      t.peers[1].undo();
      t.peers[2].update(() => void $selectIn([1], 8).insertText('k18'));
      await t.sync();
    },
  );
  expect(sentinel).toEqual([[0, '']]);
});

test.fails('#9690: session 110073: the sentinel line stays plain', async () => {
  const sentinel = await session(
    [
      ['w0abc', 'w1abc', 'w2abc', 'w3ab'],
      ['w4abc', 'w5ab', 'w6ab', 'w7abc', 'w8abcd'],
    ],
    [
      [0, 0, 0, 0],
      [0, 0, 0, 0, 2],
    ],
    {gc: true, ids: [3, 1, 2]},
    async t => {
      t.peers[1].update(() => void $selectIn([1], 0, 5).removeText());
      t.peers[1].update(() => void $selectIn([1], 0, 1).removeText());
      t.peers[0].update(() => $plain(1, 11, 'X4'));
      t.offline();
      t.peers[0].undo();
      t.peers[1].update(() => void $selectIn([1], 13, 14).removeText());
      t.peers[1].update(() => void $selectIn([1], 13, 19).removeText());
      await t.sync();
      t.offline();
      t.peers[0].update(() => $plain(1, 13, 'X4'));
      t.peers[0].update(() => void $selectIn([1], 8, 17).formatText('italic'));
      t.peers[2].update(() => $plain(1, 15, 'X6'));
      await t.sync();
      t.peers[0].undo();
      t.peers[1].update(() => void $selectIn([1], 12, 19).formatText('italic'));
      t.peers[0].undo();
      await t.sync();
    },
  );
  expect(sentinel).toEqual([[0, '']]);
});

// One client alone (the others only receive): its own bold over "aa bb cc"
// (not undoable), then plain "YZ" typed into it, bold over "aaYZ", plain "YZ"
// typed after "bb", and three undos take the bold off "cc", which none of the
// undone steps touched (the restore-side rule of #9671; #9690).
for (const ids of [[1], [1, 2], [2, 1]]) {
  test.fails(
    `#9690: one client undoing its own steps keeps "cc" bold (ids ${ids})`,
    async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('aa bb cc dd ee ff')),
          ),
        {ids, prepare},
      );
      const $bold = (from: number, to: number) => {
        for (const n of $selectIn([0], from, to).extract()) {
          if ($isTextNode(n) && !n.hasFormat('bold')) {
            n.toggleFormat('bold');
          }
        }
      };
      const $typePlain = (at: number, text: string) => {
        const s = $selectIn([0], at);
        s.format = 0;
        s.insertText(text);
      };
      t.a.update(() => $bold(0, 8));
      await t.sync();
      for (const p of t.peers) {
        p.binding.undoManager?.clear();
      }
      t.a.update(() => $typePlain(2, 'YZ'));
      t.a.update(() => $bold(0, 4));
      t.a.update(() => $typePlain(7, 'YZ'));
      for (let k = 0; k < 3; k++) {
        t.a.undo();
      }
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.describe()).toBe('paragraph("aa bb cc"{1} " dd ee ff")');
    },
  );
}
