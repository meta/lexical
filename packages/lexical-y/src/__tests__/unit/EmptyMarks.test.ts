/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Inline elements emptied by concurrent deletions.
// @vitest-environment node
import {$createMarkNode} from '@lexical/mark';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {describe, test} from 'vitest';

import {
  $block,
  $selectIn,
  type Delivery,
  expectConverged,
  setup,
} from '../utils/harness';

const ORDERS: [number[], Delivery][] = [
  [[1, 2], 'causal'],
  [[2, 1], 'causal'],
  [[1, 2], 'sender'],
  [[2, 1], 'sender'],
];
const $init = () =>
  $getRoot().append(
    $createParagraphNode().append(
      $createTextNode('ab '),
      $createMarkNode(['c0']).append($createTextNode('cdef')),
      $createTextNode(' gh'),
    ),
  );
const OPS: Record<string, () => void> = {
  delMarkHead: () => $selectIn([0], 3, 5).removeText(),
  delMarkTail: () => $selectIn([0], 5, 7).removeText(),
  delMarkText: () => $selectIn([0], 3, 7).removeText(),
  removeMarkNode: () => $block([0]).getChildAtIndex(1)!.remove(),
  setMarkTextEmpty: () =>
    $assertNodeType(
      $assertNodeType(
        $block([0]).getChildAtIndex(1),
        $isElementNode,
      ).getFirstChild(),
      $isTextNode,
    ).setTextContent(''),
  typeInMark: () => $selectIn([0], 5).insertText('X'),
};
describe('@lexical/y a mark emptied by concurrent deletions', () => {
  const pairs: [string, string][] = [
    ['delMarkHead', 'delMarkTail'],
    ['delMarkText', 'typeInMark'],
    ['delMarkText', 'delMarkText'],
    ['removeMarkNode', 'typeInMark'],
    ['delMarkHead', 'delMarkText'],
  ];
  for (const [x, y] of pairs) {
    for (const [ids, delivery] of ORDERS) {
      test(`${x} || ${y} ${ids} ${delivery}`, async () => {
        const t = await setup($init, {delivery, ids});
        t.offline();
        t.a.update(OPS[x]);
        t.b.update(OPS[y]);
        await t.sync();
        await expectConverged(t.peers);
      });
    }
  }
});
