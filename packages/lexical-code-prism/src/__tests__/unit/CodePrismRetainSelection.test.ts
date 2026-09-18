/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$createCodeNode, $isCodeNode} from '@lexical/code-core';
import {CodePrismExtension} from '@lexical/code-prism';
import {buildEditorFromExtensions} from '@lexical/extension';
import {$convertFromMarkdownString, TRANSFORMERS} from '@lexical/markdown';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  defineExtension,
} from 'lexical';
import {describe, expect, test} from 'vitest';

function createEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [RichTextExtension, CodePrismExtension],
      name: 'code-prism-retain-selection-test',
    }),
  );
}

/**
 * Describes where the caret ended up, in terms that survive the highlighter
 * splitting a code block's text into CodeHighlightNodes.
 */
function $describeCaret() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return {selection: String(selection)};
  }
  const anchorNode = selection.anchor.getNode();
  return {
    blocks: $getRoot()
      .getChildren()
      .map(child => child.getType()),
    inCodeBlock:
      $isCodeNode(anchorNode) || anchorNode.getParents().some($isCodeNode),
    offset: selection.anchor.offset,
    text: anchorNode.getTextContent(),
  };
}

/**
 * $convertFromMarkdownString only moves the caret when there already is one,
 * which is the case when a user pastes markdown into a focused editor.
 */
function $seedSelection(): void {
  const paragraph = $createParagraphNode();
  $getRoot().clear().append(paragraph);
  paragraph.selectEnd();
}

describe('Prism highlighting only retains a selection it owns (#6305)', () => {
  test('importing markdown that ends in a code block leaves the caret at the document start', () => {
    using editor = createEditor();

    editor.update($seedSelection, {discrete: true});
    editor.update(
      () => {
        $convertFromMarkdownString(
          'hello world\n\n```\necho hello world\n```',
          TRANSFORMERS,
        );
      },
      {discrete: true},
    );

    expect(editor.read($describeCaret)).toEqual({
      blocks: ['paragraph', 'code'],
      inCodeBlock: false,
      offset: 0,
      text: 'hello world',
    });
  });

  test('the caret is not dragged into the last of several imported code blocks', () => {
    using editor = createEditor();

    editor.update($seedSelection, {discrete: true});
    editor.update(
      () => {
        $convertFromMarkdownString(
          'hello world\n\n```\nfirst\n```\n\nmiddle\n\n```\nlast\n```',
          TRANSFORMERS,
        );
      },
      {discrete: true},
    );

    expect(editor.read($describeCaret)).toEqual({
      blocks: ['paragraph', 'code', 'paragraph', 'code'],
      inCodeBlock: false,
      offset: 0,
      text: 'hello world',
    });
  });

  // Control: this selection really is inside the code block, so it passes with
  // and without the fix. It guards against "fixing" #6305 by never restoring.
  test('a caret inside the code block is still retained across highlighting', () => {
    using editor = createEditor();

    editor.update(
      () => {
        const codeNode = $createCodeNode('javascript');
        const textNode = $createTextNode('const x = 1;');
        codeNode.append(textNode);
        $getRoot().clear().append(codeNode);
        // 'const ' — the caret sits inside what becomes a token boundary.
        textNode.select(6, 6);
      },
      {discrete: true},
    );

    const caret = editor.read($describeCaret);
    expect(caret.inCodeBlock).toBe(true);
    // The highlighter split the single TextNode into tokens, so the caret
    // rides along to the token that now holds text offset 6.
    expect(caret.text).toBe(' x ');
    expect(caret.offset).toBe(1);
  });
});
