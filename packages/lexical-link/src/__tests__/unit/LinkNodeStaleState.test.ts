/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createAutoLinkNode,
  $createLinkNode,
  AutoLinkNode,
  LinkNode,
} from '@lexical/link';
import {$createParagraphNode, $createTextNode, $getRoot} from 'lexical';
import {initializeUnitTest} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

describe('LinkNode stale state readers', () => {
  initializeUnitTest(
    testEnv => {
      test('isEmailURI and isWebSiteURI agree with getURL after setURL', async () => {
        const {editor} = testEnv;
        let link!: LinkNode;

        await editor.update(() => {
          link = $createLinkNode('https://lexical.dev/');
          link.append($createTextNode('Hello'));
          $getRoot().append($createParagraphNode().append(link));
        });

        await editor.update(() => {
          // setURL() goes through getWritable(), which in a later update
          // clones the node. `link` still points at the previous version, so
          // any reader that skips getLatest() answers from stale state.
          link.setURL('mailto:someone@example.com');

          expect(link.getURL()).toBe('mailto:someone@example.com');
          expect(link.isEmailURI()).toBe(true);
          expect(link.isWebSiteURI()).toBe(false);
        });
      });

      test('shouldMergeAdjacentLink compares the latest urls', async () => {
        const {editor} = testEnv;
        let first!: LinkNode;
        let second!: LinkNode;

        await editor.update(() => {
          const paragraph = $createParagraphNode();
          first = $createLinkNode('https://lexical.dev/');
          second = $createLinkNode('https://lexical.dev/');
          first.append($createTextNode('a'));
          second.append($createTextNode('b'));
          paragraph.append(first, second);
          $getRoot().append(paragraph);
        });

        await editor.update(() => {
          first.setURL('https://example.com/');

          expect(first.getURL()).not.toBe(second.getURL());
          expect(first.shouldMergeAdjacentLink(second)).toBe(false);
        });
      });

      test('getIsUnlinked reflects the latest value', async () => {
        const {editor} = testEnv;
        let autoLink!: AutoLinkNode;

        await editor.update(() => {
          autoLink = $createAutoLinkNode('https://lexical.dev/');
          autoLink.append($createTextNode('Hello'));
          $getRoot().append($createParagraphNode().append(autoLink));
        });

        await editor.update(() => {
          autoLink.setIsUnlinked(true);

          expect(autoLink.getIsUnlinked()).toBe(true);
        });
      });
    },
    {nodes: [LinkNode, AutoLinkNode]},
  );
});
