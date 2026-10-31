/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$addMarkID, $getNodeMarkIDs} from '@lexical/mark';
import {$patchStyleText} from '@lexical/selection';
import {
  $createTextNode,
  $getRoot,
  $setSelection,
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
} from '../../utils/harness';
import {prepareMarkState as prepare} from '../../utils/sizeOps';

// The tests of #9617 (parked): a collapse that keeps each key's run end.
// The #9609 cases failed while a delete collapsed the run (the collapse
// deleted the comment's end); a delete now keeps every format item it leaves
// (D86). The others held before and hold for any design.
//
// #9609: a client types text without a run's value inside the run (an
// uncommented "X" inside a commented word), so its write restores the value
// after that text and relies on the run's end (the null the comment wrote
// after the word) to end it again. A collaborator that has not seen that
// text deletes the word with its neighbours, then deletes the space after
// them, and that second delete collapses the run of deleted content and
// format items it leaves (Cursor#collapseGap): the commented word's opener
// and end are neither around the deleted space, nor the first change of the
// comments' value, nor the run's last items, and for the collaborator they
// bracket deleted content only. The collapse used to delete both, and once
// merged the restore had no end: the comment covered every later word and
// line. It keeps the end now.
//
// The bold and style cases pass without that too: a key that is a family
// of its own keeps its last items, so another run's end of the same key
// ends the restore inside the run. A comment id is one key of the
// comments' family, whose last items are other comments' items.

/** Each word of `peer`'s line `i`, with its comment ids. */
function words(peer: Peer, i = 0): string {
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

/** Each text node of `peer`'s line `i`, `*` marking bold ones. */
function boldRuns(peer: Peer, i = 0): string {
  return peer.read(() =>
    ($block([i]).getAllTextNodes() as TextNode[])
      .map(n => n.getTextContent() + (n.hasFormat('bold') ? '*' : ''))
      .join('|'),
  );
}

/** Each text node of `peer`'s line `i`, with its style. */
function styleRuns(peer: Peer, i = 0): string {
  return peer.read(() =>
    ($block([i]).getAllTextNodes() as TextNode[])
      .map(n => `${n.getTextContent()}{${n.getStyle()}}`)
      .join('|'),
  );
}

/** In `peer`'s first line, insert `text` with no format at offset `off`. */
function $insertPlainAt(off: number, text: string) {
  for (const node of $block([0]).getAllTextNodes() as TextNode[]) {
    if (off > 0 && off < node.getTextContentSize()) {
      const [, tail] = node.splitText(off);
      tail.insertBefore($createTextNode(text).setStyle(node.getStyle()));
      return;
    }
    off -= node.getTextContentSize();
  }
  throw new Error(`no text node holds offset ${off} inside it`);
}

/** Delete first-line offsets `from` to `to`. */
const $deleteIn = (from: number, to: number) => () => {
  $selectIn([0], from, to).removeText();
  $setSelection(null);
};

const LINE = 'xx aa Kilo bb cc dd';
// Offsets in LINE: "aa" 3-5, "Kilo" 6-10, "bb" 11-13, "cc" 14-16.
const WORDS: [number, number][] = [
  [3, 5],
  [6, 10],
  [11, 13],
  [14, 16],
];

describe('@lexical/y a delete collapsing a run keeps the end a concurrent restore relies on', () => {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`#9609: a comment's restore ends where the comment ended (ids ${ids})`, async () => {
      const t = await setup(
        () => $getRoot().append($p(LINE), $p('tail line')),
        {
          ids,
          prepare,
        },
      );
      t.a.update(() => {
        WORDS.forEach(([from, to], i) => {
          $addMarkID(`c${i}`, $selectIn([0], from, to));
        });
        $setSelection(null);
      });
      await t.sync();
      expect(words(t.a)).toBe('xx aa[c0] Kilo[c1] bb[c2] cc[c3] dd');
      t.offline();
      // A types uncommented "X" inside its own commented "Kilo"
      t.a.update(() => $insertPlainAt(8, 'X'));
      expect(words(t.a)).toBe('xx aa[c0] Ki[c1] X lo[c1] bb[c2] cc[c3] dd');
      // B deletes "aa Kilo bb", then the space after it
      t.b.update($deleteIn(3, 13));
      t.b.update($deleteIn(3, 4));
      expect(words(t.b)).toBe('xx cc[c3] dd');
      await t.sync();
      await expectConverged(t.peers);
      expect(words(t.a)).toBe('xx X cc[c3] dd');
      expect(words(t.a, 1)).toBe('tail line');
    });

    test(`#9609: the comment's end stays through a later collapse of the same run (ids ${ids})`, async () => {
      // As above, and B then deletes "cc " too: the first collapse removed
      // the comment's opener and kept its end, which the second collapse
      // must keep although, for B, nothing opens the comment before it.
      const t = await setup(
        () => $getRoot().append($p(LINE), $p('tail line')),
        {
          ids,
          prepare,
        },
      );
      t.a.update(() => {
        WORDS.forEach(([from, to], i) => {
          $addMarkID(`c${i}`, $selectIn([0], from, to));
        });
        $setSelection(null);
      });
      await t.sync();
      t.offline();
      t.a.update(() => $insertPlainAt(8, 'X'));
      t.b.update($deleteIn(3, 13));
      t.b.update($deleteIn(3, 4));
      t.b.update($deleteIn(3, 6));
      expect(words(t.b)).toBe('xx dd');
      await t.sync();
      await expectConverged(t.peers);
      expect(words(t.a)).toBe('xx Xdd');
      expect(words(t.a, 1)).toBe('tail line');
    });

    for (const count of [1, 16, 64, 128]) {
      test(`#9609: the restores of ${count} comment ids on one word end where the comments ended (ids ${ids})`, async () => {
        // One write gives "Kilo" every id (one item per id at each end, more
        // than an end scan of 64 structs reaches at 128).
        const marks = Array.from(
          {length: count},
          (_, i) => `m${i.toString().padStart(3, '0')}`,
        );
        const t = await setup(
          () => $getRoot().append($p(LINE), $p('tail line')),
          {ids, prepare},
        );
        t.a.update(() => {
          WORDS.forEach(([from, to], i) => {
            if (i === 1) {
              const selection = $selectIn([0], from, to);
              for (const id of marks) {
                $addMarkID(id, selection);
              }
            } else {
              $addMarkID(`c${i}`, $selectIn([0], from, to));
            }
          });
          $setSelection(null);
        });
        await t.sync();
        t.offline();
        t.a.update(() => $insertPlainAt(8, 'X'));
        t.b.update($deleteIn(3, 13));
        t.b.update($deleteIn(3, 4));
        await t.sync();
        await expectConverged(t.peers);
        expect(words(t.a)).toBe('xx X cc[c3] dd');
        expect(words(t.a, 1)).toBe('tail line');
      });
    }

    test(`a kept end leaves the value after the run as it was (ids ${ids})`, async () => {
      // c1 comments "aa" and "cc", and "cc" also has c2 and c3; B deletes
      // "aa bb " and then "xx ". The second collapse keeps the end of "aa"'s
      // comment (c1's last end), which on its own would end c1 before "cc":
      // so it also keeps c1's opener before "cc", which it drops otherwise
      // (the opener before "aa" gives "cc" c1 again).
      const t = await setup(
        () => $getRoot().append($p('xx aa bb cc dd'), $p('tail line')),
        {ids, prepare},
      );
      for (const [id, from, to] of [
        ['c1', 3, 5],
        ['c4', 6, 8],
        ['c1', 9, 11],
        ['c2', 9, 11],
        ['c3', 9, 11],
      ] as const) {
        t.a.update(() => {
          $addMarkID(id, $selectIn([0], from, to));
          $setSelection(null);
        });
      }
      await t.sync();
      expect(words(t.a)).toBe('xx aa[c1] bb[c4] cc[c1,c2,c3] dd');
      t.b.update($deleteIn(3, 9));
      await t.sync();
      t.b.update($deleteIn(0, 3));
      await t.sync();
      await expectConverged(t.peers);
      expect(words(t.b)).toBe('cc[c1,c2,c3] dd');
      // B only deleted: it wrote no item (a collapse that ended c1 before
      // "cc" made B's writer write c1 on "cc" again).
      expect(t.b.doc.store.getClock(t.b.doc.clientID)).toBe(0);
    });

    test(`a bold restore ends where the bold ended (ids ${ids})`, async () => {
      const t = await setup(
        () => $getRoot().append($p(LINE), $p('tail line')),
        {
          ids,
        },
      );
      t.a.update(() => {
        for (const [from, to] of WORDS) {
          $selectIn([0], from, to).formatText('bold');
        }
        $setSelection(null);
      });
      await t.sync();
      expect(boldRuns(t.a)).toBe('xx |aa*| |Kilo*| |bb*| |cc*| dd');
      t.offline();
      t.a.update(() => $insertPlainAt(8, 'X'));
      t.b.update($deleteIn(3, 13));
      t.b.update($deleteIn(3, 4));
      await t.sync();
      await expectConverged(t.peers);
      expect(boldRuns(t.a)).toBe('xx X|cc*| dd');
      expect(boldRuns(t.a, 1)).toBe('tail line');
    });

    test(`a style restore ends where the style went back to the text's own (ids ${ids})`, async () => {
      // The line is red and each word blue: a word's run ends with an item
      // that writes red again, not a null.
      const t = await setup(
        () => $getRoot().append($p(LINE), $p('tail line')),
        {
          ids,
        },
      );
      t.a.update(() => {
        $patchStyleText($selectIn([0], 0, LINE.length), {color: 'red'});
        for (const [from, to] of WORDS) {
          $patchStyleText($selectIn([0], from, to), {color: 'blue'});
        }
        $setSelection(null);
      });
      await t.sync();
      t.offline();
      // A types "X" in the line's own red inside "Kilo"
      t.a.update(() => {
        for (const node of $block([0]).getAllTextNodes() as TextNode[]) {
          if (node.getTextContent() === 'Kilo') {
            const [, tail] = node.splitText(2);
            tail.insertBefore($createTextNode('X').setStyle('color: red;'));
            return;
          }
        }
      });
      t.b.update($deleteIn(3, 13));
      t.b.update($deleteIn(3, 4));
      await t.sync();
      await expectConverged(t.peers);
      expect(styleRuns(t.a)).toBe(
        'xx X{color: red;}|cc{color: blue;}| dd{color: red;}',
      );
    });
  }
});
