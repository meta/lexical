/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createCodeNode,
  $isCodeHighlightNode,
  $isCodeNode,
} from '@lexical/code';
import {CodePrismExtension} from '@lexical/code-prism';
import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createTextNode,
  $getRoot,
  $isTextNode,
  defineExtension,
  KEY_TAB_COMMAND,
} from 'lexical';
import {describe, expect, test} from 'vitest';

function createEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [RichTextExtension, CodePrismExtension],
      name: 'prism-unknown-language',
    }),
  );
}

function $getCodeNode() {
  const codeNode = $getRoot().getFirstChild();
  if (!$isCodeNode(codeNode)) {
    throw new Error('Expected a CodeNode');
  }
  return codeNode;
}

describe('Prism with a language it does not know', () => {
  test('splits the text into CodeHighlightNode + LineBreakNode + TabNode', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            // e.g. what the markdown shortcut "```After " creates
            $createCodeNode('After').append($createTextNode('a\n\tb')),
          );
      },
      {discrete: true},
    );

    editor.read(() => {
      const codeNode = $getCodeNode();
      expect(codeNode.getLanguage()).toBe('After');
      expect(codeNode.getIsSyntaxHighlightSupported()).toBe(false);
      expect(
        codeNode.getChildren().map(child => child.exportJSON()),
      ).toMatchObject([
        {text: 'a', type: 'code-highlight'},
        {type: 'linebreak'},
        {type: 'tab'},
        {text: 'b', type: 'code-highlight'},
      ]);
      // Plain text: no token type from the default language's grammar.
      expect(
        codeNode
          .getChildren()
          .filter($isCodeHighlightNode)
          .map(child => child.getHighlightType()),
      ).toEqual([undefined, undefined]);
    });
  });

  test('Tab over the whole block indents every line', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createCodeNode('After').append($createTextNode('one\ntwo')));
      },
      {discrete: true},
    );
    // Select all, as the browser reports it: text point to text point.
    editor.update(
      () => {
        const codeNode = $getCodeNode();
        const first = codeNode.getFirstDescendant();
        const last = codeNode.getLastDescendant();
        if (!$isTextNode(first) || !$isTextNode(last)) {
          throw new Error('Expected the code block to hold text nodes');
        }
        first
          .select(0, 0)
          .focus.set(last.getKey(), last.getTextContentSize(), 'text');
      },
      {discrete: true},
    );

    editor.dispatchCommand(
      KEY_TAB_COMMAND,
      new KeyboardEvent('keydown', {key: 'Tab'}),
    );

    expect(editor.read(() => $getCodeNode().getTextContent())).toBe(
      '\tone\n\ttwo',
    );
  });
});
