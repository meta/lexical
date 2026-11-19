/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node
import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isParagraphNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $createTestDecoratorNode,
  $createTestShadowRootNode,
  invariant,
  TestDecoratorNode,
  TestShadowRootNode,
} from '../utils';

const testExtension = defineExtension({
  dependencies: [RichTextExtension],
  name: '[root]',
  nodes: [TestDecoratorNode, TestShadowRootNode],
});

describe('Typing at root + last-offset selection (no phantom paragraph)', () => {
  test('reuses an empty trailing paragraph instead of appending a new one', () => {
    using editor = buildEditorFromExtensions(testExtension);

    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        root.append($createParagraphNode());

        root.select(1, 1).insertText('x');
      },
      {discrete: true},
    );

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(1);
      const paragraph = children[0];
      invariant($isParagraphNode(paragraph), 'Expected ParagraphNode');
      expect(paragraph.getTextContent()).toBe('x');
    });
  });

  test('empty root still creates a new paragraph for the typed text', () => {
    using editor = buildEditorFromExtensions(testExtension);

    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        root.select(0, 0).insertText('x');
      },
      {discrete: true},
    );

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(1);
      const paragraph = children[0];
      invariant($isParagraphNode(paragraph), 'Expected ParagraphNode');
      expect(paragraph.getTextContent()).toBe('x');
    });
  });

  test('reuses an empty trailing paragraph inside a shadow root', () => {
    using editor = buildEditorFromExtensions(testExtension);

    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const shadowRoot = $createTestShadowRootNode();
        shadowRoot.append($createParagraphNode());
        root.append(shadowRoot);

        shadowRoot.select(1, 1).insertText('x');
      },
      {discrete: true},
    );

    editor.read(() => {
      const shadowRoot = $getRoot().getFirstChildOrThrow();
      invariant(
        shadowRoot instanceof TestShadowRootNode,
        'Expected TestShadowRootNode',
      );
      const children = shadowRoot.getChildren();
      expect(children).toHaveLength(1);
      const paragraph = children[0];
      invariant($isParagraphNode(paragraph), 'Expected ParagraphNode');
      expect(paragraph.getTextContent()).toBe('x');
    });
  });

  test('falls back to a new paragraph when the trailing child is a DecoratorNode', () => {
    using editor = buildEditorFromExtensions(testExtension);

    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        root.append(
          $createParagraphNode().append($createTextNode('first')),
          $createTestDecoratorNode().setIsInline(false),
        );

        root.select(2, 2).insertText('x');
      },
      {discrete: true},
    );

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(3);
      invariant($isParagraphNode(children[0]), 'Expected first paragraph');
      expect(children[0].getTextContent()).toBe('first');
      expect(children[1]).toBeInstanceOf(TestDecoratorNode);
      const newParagraph = children[2];
      invariant($isParagraphNode(newParagraph), 'Expected trailing paragraph');
      expect(newParagraph.getTextContent()).toBe('x');
    });
  });
});
