/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// An undo press can show nothing (DECISIONS.md D81, an accepted limit; y.md's
// Limits, Undo): a step whose whole effect a collaborator's change made
// invisible is taken alone. Yjs skips only a step that changes no item, and
// a step that restores or removes only format items around deleted text
// changes items but nothing a reader shows. These cells assert the press
// that also takes the next step (#9630, closed), so they are `test.fails`:
// a change of the limit shows here.

import {$addMarkID, $getNodeMarkIDs, $removeMarkID} from '@lexical/mark';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {
  $block,
  $p,
  $selectIn,
  expectConverged,
  type Peer,
  setup,
} from '../../utils/harness';
import {prepareMarkState as prepare} from '../../utils/sizeOps';

/** Each line's text runs with their format and comment ids. */
function view(peer: Peer): string {
  return peer.read(() =>
    $getRoot()
      .getChildren()
      .map(line =>
        ($block([line.getIndexWithinParent()]).getAllTextNodes() as TextNode[])
          .map(n => {
            const ids = $getNodeMarkIDs(n as LexicalNode).join(',');
            return `${n.getTextContent()}{${n.getFormat()}}[${ids}]`;
          })
          .join(''),
      )
      .join(' / '),
  );
}

for (const ids of [
  [1, 2],
  [2, 1],
]) {
  test.fails(
    `undoing a format on text a collaborator deleted takes the step before it too (${ids})`,
    async () => {
      const t = await setup(() => $getRoot().append($p('one two three')), {
        ids,
        prepare,
      });
      const um = t.a.binding.undoManager!;
      um.clear();
      t.a.update(() => {
        $selectIn([0], 13).insertText(' X');
        $setSelection(null);
      });
      um.stopCapturing();
      t.a.update(() => {
        $selectIn([0], 4, 7).formatText('bold');
        $setSelection(null);
      });
      um.stopCapturing();
      await t.sync();
      t.b.update(() => {
        $selectIn([0], 4, 8).removeText();
        $setSelection(null);
      });
      await t.sync();
      expect(view(t.a)).toBe('one three X{0}[]');
      // The bold is on deleted text only: its undo shows nothing, so the
      // press also undoes the typing before it.
      expect(t.a.binding.undo()).toBe(true);
      expect(view(t.a)).toBe('one three{0}[]');
      expect(um.undoStack).toHaveLength(0);
      // Redo brings the typing back; the bold's redo, which shows nothing,
      // is the last step: its press takes it and leaves the stack empty.
      expect(t.a.binding.redo()).toBe(true);
      expect(view(t.a)).toBe('one three X{0}[]');
      expect(t.a.binding.redo()).toBe(true);
      expect(view(t.a)).toBe('one three X{0}[]');
      expect(um.redoStack).toHaveLength(0);
      expect(t.a.binding.redo()).toBe(false);
      await t.sync();
      await expectConverged(t.peers);
      t.peers.forEach(p => p.stop());
    },
  );
}

// Where a collapse keeps the null a client's comment removal wrote on text
// a collaborator then deletes (keeping run ends did, #9617), undoing the
// removal restores only that invisible item: the press goes on to the
// underline before it. Main deletes that null, and Yjs skips the step.
test.fails(
  'undoing a comment removal on deleted text takes the format change before it too',
  async () => {
    const words = [
      ['w0abc', 'w1abc', 'w2abcd', 'w3abcd', 'w4a', 'w5ab'],
      ['w6ab', 'w7ab', 'w8abcd', 'w9abc', 'w10ab', 'w11a'],
    ];
    const formats = [
      [0, 0, 0, 0, 0, 0],
      [8, 8, 0, 2, 0, 0],
    ];
    const t = await setup(
      () => {
        words.forEach((ws, l) => {
          const p = $createParagraphNode();
          ws.forEach((w, i) =>
            p.append(
              $createTextNode(w + (i < ws.length - 1 ? ' ' : '')).setFormat(
                formats[l][i],
              ),
            ),
          );
          $getRoot().append(p);
        });
      },
      {ids: [1, 2, 3], prepare},
    );
    for (const p of t.peers) {
      p.binding.undoManager?.clear();
    }
    const [a, b, c] = t.peers;
    a.update(() => void $addMarkID('c8', $selectIn([0], 9, 18)));
    c.update(() => void $selectIn([1], 15, 18).formatText('underline'));
    b.update(() => void $selectIn([0], 5, 7).removeText());
    c.update(() => void $removeMarkID('c8', $selectIn([0], 8, 18)));
    c.update(() => void $selectIn([0], 15, 18).removeText());
    c.update(() => void $selectIn([0], 11).insertText('k11'));
    a.update(() => void $addMarkID('c13', $selectIn([0], 0, 7)));
    b.update(() => void $addMarkID('c14', $selectIn([0], 8, 14)));
    b.update(() => void $selectIn([0], 0, 14).removeText());
    b.update(() => void $selectIn([0], 0, 1).removeText());
    c.undo();
    c.undo();
    await t.sync();
    await expectConverged(t.peers);
    // The second press removes the underline from the second line.
    expect(view(a).split(' / ')[1]).toBe(
      'w6ab w7ab {8}[]w8abcd {0}[]w9abc {2}[]w10ab w11a{0}[]',
    );
    t.peers.forEach(p => p.stop());
  },
);
