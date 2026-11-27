/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Removing the only item of a nested list.
// @vitest-environment node
import {$createListItemNode, $createListNode} from '@lexical/list';
import {$createTextNode, $getRoot} from 'lexical';
import {describe, test} from 'vitest';

import {$block, expectConverged, setup} from '../utils/harness';

const $li = (s: string) => $createListItemNode().append($createTextNode(s));

describe('@lexical/y removing the only nested item', () => {
  for (const variant of [
    'first',
    'middle',
    'last-nested-of-two',
    'remove-nested-list-node',
  ]) {
    test(variant, async () => {
      const t = await setup(() => {
        if (variant === 'middle') {
          $getRoot().append(
            $createListNode('bullet').append(
              $li('one'),
              $createListItemNode().append(
                $createListNode('bullet').append($li('nested')),
              ),
              $li('three'),
            ),
          );
        } else if (variant === 'last-nested-of-two') {
          $getRoot().append(
            $createListNode('bullet').append(
              $createListItemNode().append(
                $createListNode('bullet').append($li('n1'), $li('n2')),
              ),
              $li('two'),
            ),
          );
        } else {
          $getRoot().append(
            $createListNode('bullet').append(
              $createListItemNode().append(
                $createListNode('bullet').append($li('nested')),
              ),
              $li('two'),
            ),
          );
        }
      });
      t.a.update(() => {
        if (variant === 'middle') {
          $block([0, 1, 0, 0]).remove();
        } else if (variant === 'last-nested-of-two') {
          $block([0, 0, 0, 1]).remove();
        } else if (variant === 'remove-nested-list-node') {
          $block([0, 0, 0]).remove();
        } else {
          $block([0, 0, 0, 0]).remove();
        }
      });
      await t.sync();
      await expectConverged(t.peers);
    });
  }
});
