/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {generateContent} from '@lexical/devtools-core';
import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSlot,
} from 'lexical';
import {
  $createTestDecoratorNode,
  $createTestShadowRootNode,
  TestDecoratorNode,
  TestShadowRootNode,
} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

describe('generateContent named slots', () => {
  // A DecoratorNode host reached through the children channel must recurse
  // like the slot-entry loop does, or its slot subtree is invisible in the
  // tree printout (the host renders as a bare leaf).
  test("prints a decorator host's slot subtree reached through the children channel", () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          const host = $createTestDecoratorNode().setIsInline(false);
          const media = $createTestShadowRootNode();
          media.append($createParagraphNode().append($createTextNode('Eq')));
          $getRoot().append(host);
          $setSlot(host, 'media', media);
        },
        name: '[generate-content-slots]',
        nodes: [TestDecoratorNode, TestShadowRootNode],
      }),
    );

    // Flush the (non-discrete) initial-state update so generateContent sees
    // the committed tree.
    editor.read(() => {});
    const content = generateContent(editor, [], false);
    expect(content).toContain('[slot: media]');
    expect(content).toContain('"Eq"');
  });
});
