/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions} from '@lexical/extension';
import invariant from '@lexical/internal/invariant';
import {
  $createParagraphNode,
  $getNodeByKey,
  $getRoot,
  type NodeKey,
} from 'lexical';
import {
  $createTestDecoratorNode,
  TestDecoratorNode,
} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

describe('LexicalReconciler — last-child decorator removal', () => {
  test('does not throw when an inline DecoratorNode is removed as the last child of an element', () => {
    const errors: Error[] = [];
    let decoratorKey: NodeKey = '';
    using editor = buildEditorFromExtensions({
      $initialEditorState: () => {
        const paragraph = $createParagraphNode();
        const decorator = $createTestDecoratorNode();
        paragraph.append(decorator);
        $getRoot().append(paragraph);
        decoratorKey = decorator.getKey();
      },
      name: 'lexical-reconciler-stale-decorator',
      nodes: [TestDecoratorNode],
      onError: error => {
        errors.push(error);
      },
    });

    editor.update(
      () => {
        const decorator = $getNodeByKey(decoratorKey);
        invariant(
          decorator !== null,
          'decorator missing — initial state did not commit',
        );
        decorator.remove();
      },
      {discrete: true},
    );

    expect(errors).toEqual([]);
  });
});
