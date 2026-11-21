/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The arrow keys around a QuoteContainerNode between two block decorators,
// where there is no line beside the container to land on: the caret leaves
// the container to a block cursor beside it, and enters it from one. These
// are the shadow root paths of registerRichText (#8736), which key on
// isShadowRoot(); the same moves are tested with a test-only shadow root in
// RichTextBlockCursorShadowRoot.test.ts.

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createQuoteContainerNode,
  $isQuoteContainerNode,
  QuoteContainerExtension,
} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  type LexicalCommand,
  type LexicalEditor,
  type TextNode,
} from 'lexical';
import {
  $createTestDecoratorNode,
  TestDecoratorNode,
} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, test} from 'vitest';

// root: decorator (block) / quote-container(paragraph("first") paragraph("last")) / decorator (block)
function createEditor() {
  return buildEditorFromExtensions({
    $initialEditorState: () => {
      $getRoot()
        .clear()
        .append(
          $createTestDecoratorNode().setIsInline(false),
          $createQuoteContainerNode().append(
            $createParagraphNode().append($createTextNode('first')),
            $createParagraphNode().append($createTextNode('last')),
          ),
          $createTestDecoratorNode().setIsInline(false),
        );
    },
    dependencies: [QuoteContainerExtension],
    name: 'quote-container-block-cursor',
    nodes: [TestDecoratorNode],
  });
}

function $text(which: 'first' | 'last'): TextNode {
  const quote = $getRoot().getChildAtIndex(1);
  assert($isQuoteContainerNode(quote));
  const paragraph =
    which === 'first' ? quote.getFirstChild() : quote.getLastChild();
  assert($isElementNode(paragraph));
  const text = paragraph.getFirstChild();
  assert($isTextNode(text));
  return text;
}

function press(
  editor: LexicalEditor,
  command: LexicalCommand<KeyboardEvent>,
  key: string,
): void {
  editor.dispatchCommand(
    command,
    new KeyboardEvent('keydown', {bubbles: true, cancelable: true, key}),
  );
}

/** Where the collapsed selection is: `root:offset` or `text:offset`. */
function caret(editor: LexicalEditor): string {
  return editor.read(() => {
    const selection = $getSelection();
    assert($isRangeSelection(selection));
    expect(selection.isCollapsed()).toBe(true);
    const node = selection.anchor.getNode();
    return `${$isTextNode(node) ? node.getTextContent() : node.getType()}:${selection.anchor.offset}`;
  });
}

describe('arrow keys around a QuoteContainerNode', () => {
  test.each([
    ['ArrowLeft', KEY_ARROW_LEFT_COMMAND],
    ['ArrowUp', KEY_ARROW_UP_COMMAND],
  ] as const)(
    '%s at its start leaves to a block cursor before it',
    (key, command) => {
      using editor = createEditor();
      editor.update(() => $text('first').select(0, 0), {discrete: true});
      press(editor, command, key);
      expect(caret(editor)).toBe('root:1');
    },
  );

  test.each([
    ['ArrowRight', KEY_ARROW_RIGHT_COMMAND],
    ['ArrowDown', KEY_ARROW_DOWN_COMMAND],
  ] as const)(
    '%s at its end leaves to a block cursor after it',
    (key, command) => {
      using editor = createEditor();
      editor.update(() => $text('last').select(4, 4), {discrete: true});
      press(editor, command, key);
      expect(caret(editor)).toBe('root:2');
    },
  );

  test.each([
    ['ArrowRight', KEY_ARROW_RIGHT_COMMAND],
    ['ArrowDown', KEY_ARROW_DOWN_COMMAND],
  ] as const)(
    '%s from the block cursor before it enters at its start',
    (key, command) => {
      using editor = createEditor();
      editor.update(() => $getRoot().select(1, 1), {discrete: true});
      press(editor, command, key);
      expect(caret(editor)).toBe('first:0');
    },
  );

  test.each([
    ['ArrowLeft', KEY_ARROW_LEFT_COMMAND],
    ['ArrowUp', KEY_ARROW_UP_COMMAND],
  ] as const)(
    '%s from the block cursor after it enters at its end',
    (key, command) => {
      using editor = createEditor();
      editor.update(() => $getRoot().select(2, 2), {discrete: true});
      press(editor, command, key);
      expect(caret(editor)).toBe('last:4');
    },
  );
});
