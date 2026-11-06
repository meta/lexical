/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {createHeadlessEditor} from '@lexical/headless';
import {
  $convertFromMarkdownString,
  type TextMatchTransformer,
  TRANSFORMERS,
} from '@lexical/markdown';
import {
  $getRoot,
  $getState,
  $isTextNode,
  $setState,
  createState,
  type TextNode,
} from 'lexical';
import {describe, expect, it} from 'vitest';

// https://github.com/facebook/lexical/issues/9441
describe('Issue #9441: Markdown import preserves NodeState, mode and detail of text nodes with tabs', () => {
  const markState = createState('mark', {
    parse: v => (typeof v === 'string' ? v : ''),
  });

  const MARK_WITH_STATE: TextMatchTransformer = {
    dependencies: [],
    export: () => null,
    importRegExp: /\{[^}]*\}/,
    regExp: /(?!)/,
    replace(node: TextNode) {
      $setState(node, markState, 'marked');
      node.setMode('token');
      node.toggleUnmergeable();
    },
    type: 'text-match',
  };

  it('preserves NodeState, mode, and detail on parts when a text node containing tabs is normalized', () => {
    const editor = createHeadlessEditor({
      onError(error) {
        throw error;
      },
    });

    editor.update(
      () => {
        $convertFromMarkdownString('a {b\tc} d', [
          MARK_WITH_STATE,
          ...TRANSFORMERS,
        ]);
      },
      {discrete: true},
    );

    editor.read(() => {
      const root = $getRoot();
      const paragraph = root.getFirstChild();
      expect(paragraph).not.toBeNull();
      const children = paragraph!.getChildren();

      const summary = children.map(n => [
        n.getType(),
        n.getTextContent(),
        $isTextNode(n) ? $getState(n, markState) : '',
        $isTextNode(n) ? n.getMode() : '',
        $isTextNode(n) ? n.isUnmergeable() : false,
      ]);

      expect(summary).toEqual([
        ['text', 'a ', '', 'normal', false],
        ['text', '{b', 'marked', 'token', true],
        ['tab', '\t', '', 'normal', true],
        ['text', 'c}', 'marked', 'token', true],
        ['text', ' d', '', 'normal', false],
      ]);
    });
  });
});
