/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// Sessions where keeping run ends made a reader see something other than
// main does: three peers edit two lines of words with formats and comments
// (a third line no one touches), going offline and syncing, deleting and
// undoing. Steps: comment/uncomment [peer, line, from, to, id], fmt [peer,
// line, from, to, format], del [peer, line, from, to], plain [peer, line, at,
// text] (a text node of its own: no format, no comment), inherit [peer,
// line, at, text] (typed at a caret), undo [peer], offline, sync,
// clearUndo. Reduced from randomized sessions comparing main with and
// without keeping run ends.

import {$addMarkID, $getNodeMarkIDs, $removeMarkID} from '@lexical/mark';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type LexicalNode,
  type TextFormatType,
  type TextNode,
} from 'lexical';
import {expect, test, vi} from 'vitest';

import {Cursor} from '../../../internal/Cursor';
import {
  $block,
  $selectIn,
  expectConverged,
  type Peer,
  setup,
} from '../../utils/harness';
import {prepareMarkState as prepare} from '../../utils/sizeOps';

type Step = (string | number)[];
interface Session {
  id: number;
  init: {perm: number[]; preFmt: number[][]; words: string[][]};
  steps: Step[];
}

const SESSIONS: Session[] = [
  {
    id: 2725,
    init: {
      perm: [1, 3, 2],
      preFmt: [
        [2, 1, 8, 2, 0, 8, 0],
        [0, 0, 0, 0, 0],
      ],
      words: [
        ['w0abc', 'w1a', 'w2abc', 'w3abcd', 'w4abc', 'w5abc', 'w6abcd'],
        ['w7abcd', 'w8ab', 'w9abc', 'w10a', 'w11ab'],
      ],
    },
    steps: [
      ['plain', 2, 0, 2, 'X10'],
      ['comment', 1, 0, 0, 5, 'c15'],
      ['comment', 0, 0, 6, 9, 'c16'],
      ['del', 1, 0, 5, 9],
      ['plain', 1, 0, 5, ' q18'],
      ['del', 1, 0, 5, 9],
      ['del', 1, 0, 5, 9],
      ['plain', 1, 0, 5, ' q21'],
      ['del', 1, 0, 5, 9],
      ['offline'],
      ['plain', 0, 0, 3, 'xq16'],
      ['del', 1, 0, 0, 6],
      ['sync'],
      ['del', 0, 0, 4, 12],
      ['undo', 1],
      ['plain', 1, 0, 4, ' yz23'],
      ['undo', 1],
      ['undo', 1],
    ],
  },
  {
    id: 1861,
    init: {
      perm: [1, 3, 2],
      preFmt: [
        [2, 8, 1, 1],
        [8, 1, 0, 2, 0],
      ],
      words: [
        ['w0a', 'w1abc', 'w2ab', 'w3ab'],
        ['w4ab', 'w5a', 'w6a', 'w7a', 'w8abc'],
      ],
    },
    steps: [
      ['comment', 0, 1, 0, 8, 'c7'],
      ['comment', 1, 1, 0, 4, 'c14'],
      ['plain', 1, 1, 4, ' q17'],
      ['comment', 1, 1, 5, 8, 'c17'],
      ['del', 1, 1, 4, 8],
      ['plain', 1, 1, 4, ' q18'],
      ['comment', 1, 1, 5, 8, 'c18'],
      ['del', 1, 1, 4, 8],
      ['plain', 0, 1, 2, 'X15'],
      ['del', 0, 1, 4, 12],
      ['inherit', 0, 1, 1, 'k18'],
      ['del', 0, 1, 6, 7],
      ['undo', 1],
    ],
  },
  {
    id: 3645,
    init: {
      perm: [1, 3, 2],
      preFmt: [
        [0, 0, 0, 8, 2, 0, 0],
        [0, 2, 0, 0, 0],
      ],
      words: [
        ['w0a', 'w1a', 'w2ab', 'w3abcd', 'w4a', 'w5abc', 'w6abcd'],
        ['w7a', 'w8ab', 'w9abc', 'w10ab', 'w11ab'],
      ],
    },
    steps: [
      ['plain', 0, 0, 31, 'xq4'],
      ['plain', 0, 0, 34, 'xq5'],
      ['comment', 2, 0, 24, 42, 'c9'],
      ['plain', 2, 0, 28, ' yz9'],
      ['comment', 1, 0, 29, 33, 'c13'],
      ['del', 1, 0, 24, 33],
      ['del', 1, 0, 24, 25],
      ['undo', 1],
      ['undo', 2],
    ],
  },
  {
    id: 4694,
    init: {
      perm: [1, 2, 3],
      preFmt: [
        [0, 1, 1, 0],
        [0, 0, 8, 0, 0, 2],
      ],
      words: [
        ['w0abcd', 'w1abcd', 'w2ab', 'w3a'],
        ['w4abcd', 'w5a', 'w6abc', 'w7abcd', 'w8a', 'w9a'],
      ],
    },
    steps: [
      ['comment', 0, 1, 0, 6, 'c1'],
      ['comment', 0, 1, 0, 10, 'c2'],
      ['sync'],
      ['clearUndo'],
      ['offline'],
      ['plain', 0, 1, 26, ' yz2'],
      ['undo', 2],
      ['inherit', 2, 0, 14, 'k3'],
      ['sync'],
      ['comment', 1, 1, 24, 26, 'c5'],
      ['comment', 0, 1, 27, 31, 'c6'],
      ['sync'],
      ['offline'],
      ['plain', 1, 1, 25, 'Zz6'],
      ['del', 0, 1, 24, 26],
      ['del', 0, 1, 24, 25],
      ['sync'],
      ['inherit', 1, 1, 19, 'k6'],
      ['inherit', 1, 1, 8, 'k7'],
      ['plain', 2, 0, 9, 'Q 8'],
      ['inherit', 2, 1, 0, 'k9'],
      ['inherit', 2, 1, 0, 'k10'],
      ['sync'],
      ['offline'],
      ['inherit', 1, 0, 8, 'k11'],
      ['sync'],
      ['comment', 0, 1, 24, 32, 'c13'],
      ['comment', 1, 1, 33, 40, 'c14'],
      ['sync'],
      ['plain', 0, 1, 32, ' q15'],
      ['comment', 0, 1, 33, 36, 'c15'],
      ['del', 0, 1, 32, 36],
      ['plain', 0, 1, 32, ' q16'],
      ['fmt', 0, 1, 33, 36, 'italic'],
      ['del', 0, 1, 32, 36],
      ['plain', 0, 1, 32, ' q17'],
      ['comment', 0, 1, 33, 36, 'c17'],
      ['del', 0, 1, 32, 36],
      ['offline'],
      ['plain', 1, 1, 26, 'X14'],
      ['del', 0, 1, 24, 33],
      ['sync'],
      ['del', 0, 0, 10, 13],
      ['del', 0, 0, 14, 17],
      ['del', 0, 1, 16, 23],
      ['inherit', 1, 1, 11, 'k17'],
      ['sync'],
      ['comment', 1, 1, 0, 14, 'c19'],
      ['comment', 0, 1, 15, 19, 'c20'],
      ['sync'],
      ['offline'],
      ['plain', 1, 1, 5, 'Zz20'],
      ['del', 0, 1, 0, 14],
      ['del', 0, 1, 0, 1],
      ['sync'],
    ],
  },
];

function $plainAt(line: number, at: number, text: string): void {
  let off = at;
  for (const node of $block([line]).getAllTextNodes() as TextNode[]) {
    const size = node.getTextContentSize();
    if (off > 0 && off < size) {
      node.splitText(off)[1].insertBefore($createTextNode(text));
      return;
    }
    if (off === size) {
      node.insertAfter($createTextNode(text));
      return;
    }
    off -= size;
  }
}

/** Each character of a line with its format and comment ids. */
function chars(peer: Peer, line: number): string[] {
  return peer.read(() =>
    ($block([line]).getAllTextNodes() as TextNode[]).flatMap(n => {
      const ids = $getNodeMarkIDs(n as LexicalNode)
        .slice()
        .sort();
      return Array.from(
        n.getTextContent(),
        c => `${c}{${n.getFormat()}}[${ids.join(',')}]`,
      );
    }),
  );
}

async function replay(script: Session) {
  const {perm, preFmt, words} = script.init;
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
    {ids: perm, prepare},
  );
  for (const [op, p, ...a] of script.steps) {
    const peer = t.peers[p as number];
    const [l, x, y, z] = a as [number, number, number, string];
    if (op === 'comment') {
      peer.update(() => void $addMarkID(z, $selectIn([l], x, y)));
    } else if (op === 'uncomment') {
      peer.update(() => void $removeMarkID(z, $selectIn([l], x, y)));
    } else if (op === 'fmt') {
      peer.update(
        () => void $selectIn([l], x, y).formatText(z as TextFormatType),
      );
    } else if (op === 'del') {
      peer.update(() => void $selectIn([l], x, y).removeText());
    } else if (op === 'plain') {
      peer.update(() => $plainAt(l, x, String(a[2])));
    } else if (op === 'inherit') {
      peer.update(() => void $selectIn([l], x, x).insertText(String(a[2])));
    } else if (op === 'undo') {
      peer.undo();
    } else if (op === 'offline') {
      t.offline();
    } else if (op === 'sync') {
      await t.sync();
    } else if (op === 'clearUndo') {
      for (const q of t.peers) {
        q.binding.undoManager?.clear();
      }
    }
  }
  await t.sync();
  await expectConverged(t.peers);
  return t;
}

function session(id: number): Session {
  return SESSIONS.find(s => s.id === id)!;
}

/** The comment ids each character of `word` (in line `line`) has. */
function idsOn(peer: Peer, line: number, word: string): string[] {
  const cs = chars(peer, line);
  const text = cs.map(c => c.charAt(0)).join('');
  const at = text.indexOf(word);
  expect(at).toBeGreaterThanOrEqual(0);
  return cs.slice(at, at + word.length).map(c => c.slice(c.indexOf('[')));
}

// " q21" is typed without a comment (a text node of its own) and deleted;
// an undo brings it back after deletes next to it collapsed the run where
// it was. A collapse that kept only a later null, whose run had lost its
// opener, and not the end of the comment c15 before it, gave it c15.
test('restored text that never had a comment takes none (2725)', async () => {
  const t = await replay(session(2725));
  expect(idsOn(t.a, 0, ' q21')).toEqual(['[]', '[]', '[]', '[]']);
  t.peers.forEach(p => p.stop());
});

// " q18" is typed without a comment and then commented c18 only, on a line
// a collaborator commented c14 and c7 at its start; it never has c14.
test('restored text takes no comment of the word before it (1861)', async () => {
  const t = await replay(session(1861));
  expect(idsOn(t.a, 1, ' q18').every(ids => !ids.includes('c14'))).toBe(true);
  t.peers.forEach(p => p.stop());
});

// A comment over words that deletes and undos around them never touch
// stays where a document read without any collapse has it: the collapse
// dropped c2 from "wk75" (4694); a delete now keeps every format item it
// leaves (D86).
test('a comment stays on text that deletes around it never touched (4694)', async () => {
  const t = await replay(session(4694));
  expect(idsOn(t.a, 1, 'wk75')).toEqual(Array(4).fill('[c2,c20]'));
  t.peers.forEach(p => p.stop());
});

// Main's collapse dropped c9 from "wxq4xq56abcd" (3645), where a document
// read without any collapse keeps it. The drop shows only after the
// session's last undo, so this also flips without a collapse change where
// that undo takes more steps: with every undo press changing what the
// document shows (#9630), the undo also removes c9 without a collapse.
test.fails(
  'a comment is where a document without any collapse has it (3645; also flips with #9630)',
  async () => {
    const t = await replay(session(3645));
    const kept = chars(t.a, 0);
    t.peers.forEach(p => p.stop());
    const spy = vi
      .spyOn(
        Cursor.prototype as unknown as {collapseGap: () => void},
        'collapseGap',
      )
      .mockImplementation(() => {});
    try {
      const u = await replay(session(3645));
      expect(kept).toEqual(chars(u.a, 0));
      u.peers.forEach(p => p.stop());
    } finally {
      spy.mockRestore();
    }
  },
);
