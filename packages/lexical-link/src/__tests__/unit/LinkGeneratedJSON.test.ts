/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {AutoLinkNode, LinkNode} from '@lexical/link';
import {$expectSameJSON, initializeUnitTest} from 'lexical/src/__tests__/utils';
import {describe, test} from 'vitest';

describe('link generated exportJSON', () => {
  initializeUnitTest(
    testEnv => {
      test('LinkNode agrees with the schema-driven walk', () => {
        testEnv.editor.update(
          () => {
            $expectSameJSON(new LinkNode());
            $expectSameJSON(
              new LinkNode('https://example.com/', {
                rel: 'noreferrer',
                target: '_blank',
                title: 'Example',
              }).setIndent(1),
            );
          },
          {discrete: true},
        );
      });

      test('AutoLinkNode agrees with the schema-driven walk', () => {
        testEnv.editor.update(
          () => {
            $expectSameJSON(new AutoLinkNode());
            $expectSameJSON(
              new AutoLinkNode('https://example.com/', {
                isUnlinked: true,
                target: '_blank',
              }),
            );
          },
          {discrete: true},
        );
      });
    },
    {
      namespace: 'test',
      nodes: [LinkNode, AutoLinkNode],
      theme: {},
    },
  );
});
