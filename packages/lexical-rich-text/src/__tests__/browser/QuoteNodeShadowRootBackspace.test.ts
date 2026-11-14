/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createQuoteNode,
  $isQuoteNode,
  RichTextExtension,
} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  type LexicalNode,
} from 'lexical';
import {assert, expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

/** A paragraph's text, or the blocks of a shadow root quote. */
type Block = string | Block[];

function $describeBlock(node: LexicalNode): Block {
  if ($isQuoteNode(node)) {
    assert(node.isShadowRoot(), 'every quote should be a shadow root');
    return node.getChildren().map($describeBlock);
  }
  assert($isParagraphNode(node), 'every block should be a paragraph');
  return node.getTextContent();
}

// The unit tests run Backspace under jsdom, which has no Selection.modify, so
// they skip the measurement deleteCharacter makes in a browser. This runs it
// in a real browser, with a paragraph before the quote.
test('Backspace at the start of the first line of a shadow root quote after a paragraph moves only that line out', async () => {
  const rootElement = document.createElement('div');
  rootElement.contentEditable = 'true';
  document.body.appendChild(rootElement);
  const editor = buildEditorFromExtensions({
    $initialEditorState: () => {
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append($createTextNode('p')),
          $createQuoteNode({shadowRoot: true}).append(
            $createParagraphNode().append($createTextNode('a')),
            $createParagraphNode().append($createTextNode('b')),
          ),
        );
    },
    dependencies: [RichTextExtension],
    name: 'quote-shadow-root-backspace',
  });
  editor.setRootElement(rootElement);
  onTestFinished(() => {
    editor.setRootElement(null);
    rootElement.remove();
    editor.dispose();
  });
  rootElement.focus();
  editor.update(
    () => {
      const quote = $getRoot().getLastChild();
      assert($isQuoteNode(quote));
      const line = quote.getFirstChild();
      assert($isParagraphNode(line));
      line.selectStart();
    },
    {discrete: true},
  );

  await userEvent.keyboard('{Backspace}');

  editor.read(() => {
    expect($getRoot().getChildren().map($describeBlock)).toEqual([
      'p',
      'a',
      ['b'],
    ]);
    const selection = $getSelection();
    assert($isRangeSelection(selection) && selection.isCollapsed());
    const node = selection.anchor.getNode();
    const line = $isTextNode(node) ? node.getParentOrThrow() : node;
    expect(line.is($getRoot().getChildAtIndex(1))).toBe(true);
    expect(selection.anchor.offset).toBe(0);
  });
});
