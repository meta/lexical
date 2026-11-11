/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$toggleLink, LinkNode} from '@lexical/link';
import * as Y from '@y/y';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  type ElementNode,
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

function caret(peer: Peer): [string, number] | null {
  return peer.read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
      return null;
    }
    const node = selection.anchor.getNode();
    return [node.getTextContent(), selection.anchor.offset];
  });
}

/** Type at the current selection, as a keystroke would. */
function type(peer: Peer, text: string) {
  peer.update(() => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      selection.insertText(text);
    }
  });
}

describe('@lexical/y local selection across remote changes', () => {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`a caret at the end stays after its own text (ids ${ids})`, async () => {
      const t = await setup(() => $getRoot().append($p('hello world')), {ids});
      t.b.update(() => $selectIn([0], 11));
      for (const [a, b] of [
        ['1', 'a'],
        ['2', 'b'],
        ['3', 'c'],
      ]) {
        t.offline();
        t.a.update(() => $selectIn([0], 0).insertText(a));
        type(t.b, b);
        await t.sync();
      }
      await expectConverged(t.peers, 'paragraph("321hello worldabc")');
      expect(caret(t.b)).toEqual(['321hello worldabc', 17]);
    });

    test(`a caret survives a peer splitting its line before it (ids ${ids})`, async () => {
      const t = await setup(() => $getRoot().append($p('one two three')), {
        ids,
      });
      t.b.update(() => $selectIn([0], 13));
      t.offline();
      t.a.update(() => $selectIn([0], 3).insertParagraph());
      type(t.b, '!');
      await t.sync();
      type(t.b, '?');
      await t.sync();
      await expectConverged(
        t.peers,
        'paragraph("one") / paragraph(" two three!?")',
      );
    });

    test(`a caret survives a peer deleting the text before it (ids ${ids})`, async () => {
      const t = await setup(() => $getRoot().append($p('abcdef')), {ids});
      t.b.update(() => $selectIn([0], 4));
      t.offline();
      t.a.update(() => $selectIn([0], 0, 3).removeText());
      type(t.b, 'X');
      await t.sync();
      type(t.b, 'Y');
      await t.sync();
      await expectConverged(t.peers, 'paragraph("dXYef")');
    });
  }

  test('a caret stays put across a later change after a peer joined its line away', async () => {
    const t = await setup(
      () => $getRoot().append($p('r1z r2z'), $p('r3z r4z')),
      {
        ids: [101, 202, 303],
      },
    );
    const [a, b, c] = t.peers;
    t.offline();
    a.update(() => $selectIn([0], 3).insertParagraph());
    type(a, 'ka1');
    // B presses Backspace at the start of line 2; C types at its end.
    b.update(() => {
      const first = $block([0]) as ElementNode;
      const second = $block([1]) as ElementNode;
      first.append(...second.getChildren());
      second.remove();
    });
    c.update(() => $selectIn([1], 7).insertText(' kc1z'));
    const send = (from: Peer, to: Peer) =>
      Y.applyUpdate(
        to.doc,
        Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)),
      );
    send(b, a);
    expect(caret(a)).toEqual(['ka1 r2zr3z r4z', 3]);
    send(c, a);
    expect(caret(a)).toEqual(['ka1 r2zr3z r4z kc1z', 3]);
    type(a, 'z');
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph("r1z") / paragraph("ka1z r2zr3z r4z kc1z")',
    );
  });

  test('a space typed next to a space is written where the caret is', async () => {
    const t = await setup(() => $getRoot().append($p('i1z i2z')));
    t.b.update(() => $selectIn([0], 3));
    t.offline();
    type(t.b, ' ');
    type(t.b, 'k');
    t.a.update(() => $selectIn([0], 4).insertText('t'));
    await t.sync();
    await expectConverged(t.peers, 'paragraph("i1z k ti2z")');
  });

  test('a range selection does not grow over concurrent inserts at its edges', async () => {
    const t = await setup(() => $getRoot().append($p('abcdef')));
    t.b.update(() => $selectIn([0], 2, 4));
    t.a.update(() => $selectIn([0], 4).insertText('Z'));
    t.a.update(() => $selectIn([0], 2).insertText('Y'));
    await t.sync();
    expect(
      t.b.read(() => {
        const s = $getSelection();
        return $isRangeSelection(s) ? s.getTextContent() : null;
      }),
    ).toBe('cd');
  });
});

describe('@lexical/y inline format properties', () => {
  test('changing a link URL syncs', async () => {
    const t = await setup(() => $getRoot().append($p('see the docs here')));
    t.a.update(() => {
      $selectIn([0], 8, 12);
      $toggleLink('https://a.example/');
    });
    await t.sync();
    t.a.update(() => {
      const link = ($block([0]) as ElementNode)
        .getChildren()
        .find(c => c instanceof LinkNode) as LinkNode;
      link.setURL('https://b.example/');
    });
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph("see the " link<https://b.example/>("docs") " here")',
    );
    t.b.update(() => $selectIn([0], 17).insertText('!'));
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph("see the " link<https://b.example/>("docs") " here!")',
    );
  });
});
