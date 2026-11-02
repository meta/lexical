/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// Two collaborators bold overlapping ranges at the same time: A bolds
// t4z..t7z while B bolds t3z..t6z. t7z should end bold: A bolded it and
// nobody else touched it. Two items of one format key at one spot resolve by
// client id, and part of A's range ends plain (#9626), without a link for
// both client id orders. With A first linking t5z t6z (A's bold then crosses
// the link's end), main kept t7z bold for client ids 2,1 only because A's
// bold also wrote the link's value again; a link's text fields are no longer
// stored (#9597), so the link behaves like a mark there and t7z ends plain
// for both orders: expected failures naming #9626.

import {$toggleLink} from '@lexical/link';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {$selectIn, expectConverged, setup} from '../../utils/harness';

const LINE = 't1z t2z t3z t4z t5z t6z t7z t8z';
const at = (word: string) => LINE.indexOf(word);

for (const ids of [
  [1, 2],
  [2, 1],
]) {
  for (const [name, aLinksFirst, bBolds] of [
    ['A links t5z t6z, then bolds t4z..t7z || B bolds t3z..t6z', true, true],
    ['A bolds t4z..t7z || B bolds t3z..t6z (no link)', false, true],
    ['control: A links t5z t6z, then bolds t4z..t7z', true, false],
  ] as [string, boolean, boolean][]) {
    // #9626: overlapping bolds of two collaborators leave part plain.
    const known = bBolds;
    (known ? test.fails : test)(
      `${name}, ids ${ids}: t7z keeps A's bold${known ? ' (#9626)' : ''}`,
      async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode(LINE)),
            );
          },
          {ids},
        );
        try {
          t.offline();
          if (aLinksFirst) {
            t.a.update(() => {
              $selectIn([0], at('t5z'), at('t6z') + 3);
              $toggleLink('https://x.test/12');
              $setSelection(null);
            });
          }
          t.a.update(() => {
            $selectIn([0], at('t4z'), at('t7z') + 3).formatText('bold');
            $setSelection(null);
          });
          if (bBolds) {
            t.b.update(() => {
              $selectIn([0], at('t3z'), at('t6z') + 3).formatText('bold');
              $setSelection(null);
            });
          }
          await t.sync();
          await expectConverged(t.peers);
          expect(
            t.a.read(() =>
              (
                $getRoot()
                  .getAllTextNodes()
                  .find(n => n.getTextContent().includes('t7z')) as TextNode
              ).hasFormat('bold'),
            ),
          ).toBe(true);
        } finally {
          for (const p of t.peers) {
            p.stop();
          }
        }
      },
    );
  }
}
