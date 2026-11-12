/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $createCodeHighlightNode,
  $createCodeNode,
  $isCodeHighlightNode,
  CodeHighlightNode,
} from '@lexical/code-core';
import {CodePrismExtension} from '@lexical/code-prism';
import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $create,
  $createParagraphNode,
  $getRoot,
  $getState,
  $isTextNode,
  $setState,
  createState,
  defineExtension,
  TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

const parseString = (value: unknown) =>
  typeof value === 'string' ? value : '';
const noteState = createState('note', {parse: parseString});
const flatState = createState('flatNote', {parse: parseString});
const createdState = createState('created', {parse: parseString});

/** A code highlight node with a flat state (serialized at the top level) */
class FlatHighlightNode extends CodeHighlightNode {
  $config() {
    return this.config('test-flat-highlight', {
      extends: CodeHighlightNode,
      stateConfigs: [{flat: true, stateConfig: flatState}],
    });
  }
}

/** A TextNode replacement that sets a state of its own when it is created */
class CreatedTextNode extends TextNode {
  $config() {
    return this.config('test-created-text', {
      extends: TextNode,
      stateConfigs: [createdState],
    });
  }
}

test('code highlight nodes turned back into text when they leave a code block keep their NodeState', () => {
  using editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [RichTextExtension, CodePrismExtension],
      name: 'leave-code-node-state',
      onError: (error: Error) => {
        throw error;
      },
    }),
  );
  editor.update(
    () => {
      const token = $createCodeHighlightNode('note');
      $setState(token, noteState, 'kept');
      $getRoot().append($createCodeNode().append(token));
    },
    {discrete: true},
  );
  editor.update(
    () => {
      $getRoot().getFirstChildOrThrow().replace($createParagraphNode(), true);
    },
    {discrete: true},
  );
  expect(
    editor.read(() =>
      $getRoot()
        .getAllTextNodes()
        .map(node => [
          $isTextNode(node) && !$isCodeHighlightNode(node),
          node.getTextContent(),
          $getState(node, noteState),
        ]),
    ),
  ).toEqual([[true, 'note', 'kept']]);
});

test('the copy includes flat states and keeps the state of a TextNode replacement', () => {
  using editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [RichTextExtension, CodePrismExtension],
      name: 'leave-code-flat-node-state',
      nodes: () => [
        FlatHighlightNode,
        {
          replace: CodeHighlightNode,
          with: (node: CodeHighlightNode) =>
            $create(FlatHighlightNode).setTextContent(node.getTextContent()),
          withKlass: FlatHighlightNode,
        },
        CreatedTextNode,
        {
          replace: TextNode,
          with: (node: TextNode) =>
            $setState(
              $create(CreatedTextNode).setTextContent(node.getTextContent()),
              createdState,
              'yes',
            ),
          withKlass: CreatedTextNode,
        },
      ],
      onError: (error: Error) => {
        throw error;
      },
    }),
  );
  editor.update(
    () => {
      $getRoot().append(
        $createCodeNode().append($createCodeHighlightNode('note')),
      );
    },
    {discrete: true},
  );
  // Once highlighting has made its tokens
  editor.update(
    () => {
      for (const token of $getRoot().getAllTextNodes()) {
        $setState(token, flatState, 'kept');
        $setState(token, noteState, 'kept');
      }
    },
    {discrete: true},
  );
  editor.update(
    () => {
      $getRoot().getFirstChildOrThrow().replace($createParagraphNode(), true);
    },
    {discrete: true},
  );
  expect(
    editor.read(() =>
      $getRoot()
        .getAllTextNodes()
        .map(node => [
          node.getType(),
          $getState(node, flatState),
          $getState(node, noteState),
          $getState(node, createdState),
        ]),
    ),
  ).toEqual([['test-created-text', 'kept', 'kept', 'yes']]);
});
