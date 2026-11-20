/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// NodeState set back to its default.
// @vitest-environment node
import {$createListItemNode, $createListNode} from '@lexical/list';
import {$createHeadingNode} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setState,
  createState,
} from 'lexical';
import {describe, test} from 'vitest';

import {$block, $selectIn, expectConverged, setup} from '../utils/harness';

const zz = createState('zz', {parse: v => (typeof v === 'string' ? v : '')});

describe('@lexical/y NodeState default', () => {
  test('paragraph: state s1 then back to default', async () => {
    const t = await setup(() =>
      $getRoot().append($createParagraphNode().append($createTextNode('a'))),
    );
    t.a.update(() => $setState($block([0]), zz, 's1'));
    await t.sync();
    t.a.update(() => $setState($block([0]), zz, ''));
    await t.sync();
    await expectConverged(t.peers);
  });
  test('list item with state -> heading via $setBlocksType', async () => {
    const t = await setup(() =>
      $getRoot().append(
        $createListNode('check').append(
          $createListItemNode().append($createTextNode('one')),
          $createListItemNode().append($createTextNode('two')),
        ),
      ),
    );
    t.a.update(() => $setState($block([0, 1]), zz, 's1'));
    await t.sync();
    t.a.update(() => $setState($block([0, 1]), zz, ''));
    await t.sync();
    t.a.update(() =>
      $setBlocksType($selectIn([0, 0], 0), () => $createHeadingNode('h2')),
    );
    await t.sync();
    await expectConverged(t.peers);
  });
});
