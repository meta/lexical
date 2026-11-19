/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// A comment on a word a collaborator rewrites at the same moment (#9610),
// an accepted limit (DECISIONS.md D93, y.md's Limits, Other races): B, who
// has not seen A's rewrite, comments the old word, and the comment can land
// on the new word A wrote in its place. It is the race of text typed at the
// start of a range a collaborator formats: the new word is inserted where
// the commented word starts, and Yjs orders the two writes by client id.
// The cells where the comment reaches the new word are `test.fails`, so that
// a change of the limit shows here. Words of B's range that A kept keep the
// comment in every cell.

import {$addMarkID, $getNodeMarkIDs} from '@lexical/mark';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  type ElementNode,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {expectConverged, type Peer, setup} from '../../utils/harness';
import {prepareMarkState as prepare} from '../../utils/sizeOps';

/** The words of every text node holding comment `id`. */
const commented = (peer: Peer, id: string) =>
  peer.read(() =>
    ($getRoot().getAllTextNodes() as TextNode[])
      .filter(n => $getNodeMarkIDs(n as LexicalNode).includes(id))
      .flatMap(n => n.getTextContent().split(/\s+/).filter(Boolean)),
  );

/** A range selection from the start of word `a` to the end of word `b` of line 1. */
function $selectWords(a: string, b: string) {
  const block = $getRoot().getChildAtIndex(1) as ElementNode;
  const text = block.getTextContent();
  const start = text.indexOf(a);
  const end = text.indexOf(b) + b.length;
  const point = (offset: number, isStart: boolean): [string, number] => {
    let at = 0;
    for (const leaf of block.getAllTextNodes()) {
      const size = leaf.getTextContentSize();
      if (isStart ? offset < at + size : offset <= at + size) {
        return [leaf.getKey(), offset - at];
      }
      at += size;
    }
    throw new Error('no text node at offset ' + offset);
  };
  const [anchorKey, anchorOffset] = point(start, true);
  const [focusKey, focusOffset] = point(end, false);
  const selection = $createRangeSelection();
  selection.anchor.set(anchorKey, anchorOffset, 'text');
  selection.focus.set(focusKey, focusOffset, 'text');
  $setSelection(selection);
  return selection;
}

describe('a comment on a word a collaborator rewrites in a block rewrite', () => {
  // A rewrites line 1 as an agent does (its children removed, one new text
  // node with t23z changed to t66z) while B comments c9.
  const ranges: [string, string, string[]][] = [
    ['t23z', 't23z', []],
    ['t22z', 't23z', ['t22z']],
    ['t23z', 't24z', ['t24z']],
  ];
  for (const [from, to, kept] of ranges) {
    for (const order of ['rewrite first', 'comment first']) {
      for (const ids of [
        [1, 2],
        [2, 1],
      ]) {
        // D93: the comment reaches the new word for ids [1, 2], and for
        // both orders where B's range ends after it.
        const known = ids[0] === 1 || to === 't24z';
        (known ? test.fails : test)(
          `c9 on ${from}..${to}, ${order}, ids ${ids}`,
          async () => {
            const t = await setup(
              () =>
                $getRoot().append(
                  $createParagraphNode().append($createTextNode('head')),
                  $createParagraphNode().append(
                    $createTextNode('t21z t22z t23z t24z t25z'),
                  ),
                ),
              {ids, prepare},
            );
            t.offline();
            const $rewrite = () => {
              const block = $getRoot().getChildAtIndex(1) as ElementNode;
              const next = block.getTextContent().replace('t23z', 't66z');
              for (const child of block.getChildren()) {
                child.remove();
              }
              block.append($createTextNode(next));
            };
            const $comment = () =>
              void $addMarkID('c9', $selectWords(from, to));
            if (order === 'rewrite first') {
              t.a.update($rewrite);
              t.b.update($comment);
            } else {
              t.b.update($comment);
              t.a.update($rewrite);
            }
            await t.sync();
            await expectConverged(t.peers);
            expect(commented(t.a, 'c9')).toEqual(kept);
          },
        );
      }
    }
  }
});

describe('a comment on a word a collaborator rewrites with setTextContent', () => {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    // D93: the comment reaches the new word for ids [1, 2].
    (ids[0] === 1 ? test.fails : test)(
      `A rewrites "wx" to "yz" while B comments "wx" (ids ${ids})`,
      async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append($createTextNode('head')),
              $createParagraphNode().append($createTextNode('aa wx bb')),
            ),
          {ids, prepare},
        );
        t.offline();
        t.a.update(() => {
          const block = $getRoot().getChildAtIndex(1) as ElementNode;
          (block.getFirstChildOrThrow() as TextNode).setTextContent('aa yz bb');
        });
        t.b.update(() => void $addMarkID('c1', $selectWords('wx', 'wx')));
        await t.sync();
        await expectConverged(t.peers);
        expect(commented(t.a, 'c1')).toEqual([]);
      },
    );
  }
});
