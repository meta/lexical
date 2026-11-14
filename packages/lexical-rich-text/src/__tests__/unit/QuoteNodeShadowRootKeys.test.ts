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
  $isElementNode,
  $isParagraphNode,
  $isRangeSelection,
  $isRootNode,
  $isTextNode,
  defineExtension,
  DELETE_CHARACTER_COMMAND,
  KEY_ENTER_COMMAND,
  type LexicalNode,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

function buildEditor() {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [RichTextExtension],
      name: 'quote-shadow-root-keys-host',
    }),
  );
  // Backspace reads the window from the root element.
  editor.setRootElement(document.createElement('div'));
  return editor;
}

/** A paragraph's text, or the blocks of a shadow root quote. */
type Block = string | Block[];

function $createBlock(block: Block): LexicalNode {
  return typeof block === 'string'
    ? $createParagraphNode().append(
        ...(block === '' ? [] : [$createTextNode(block)]),
      )
    : $createQuoteNode({shadowRoot: true}).append(...block.map($createBlock));
}

function $describeBlock(node: LexicalNode): Block {
  if ($isQuoteNode(node)) {
    assert(node.isShadowRoot(), 'every quote should be a shadow root');
    return node.getChildren().map($describeBlock);
  }
  assert($isParagraphNode(node), 'every block should be a paragraph');
  return node.getTextContent();
}

/** The child indexes from the root down to `node`. */
function $getPath(node: LexicalNode): number[] {
  const path: number[] = [];
  for (let n = node; !$isRootNode(n); n = n.getParentOrThrow()) {
    path.unshift(n.getIndexWithinParent());
  }
  return path;
}

/**
 * Puts the root's blocks in place, with the caret on the line at `caretPath`:
 * at its end for Enter, at its start for Backspace. Then presses the key.
 * Returns the blocks after it, and the path of the line that holds the caret.
 */
function pressKey(
  key: 'Backspace' | 'Enter',
  blocks: Block[],
  caretPath: number[],
): {blocks: Block[]; caret: number[]} {
  using editor = buildEditor();
  editor.update(
    () => {
      let line: LexicalNode = $getRoot()
        .clear()
        .append(...blocks.map($createBlock));
      for (const index of caretPath) {
        assert($isElementNode(line));
        const child = line.getChildAtIndex(index);
        assert(child !== null);
        line = child;
      }
      assert($isParagraphNode(line));
      if (key === 'Enter') {
        line.selectEnd();
      } else {
        line.selectStart();
      }
    },
    {discrete: true},
  );
  if (key === 'Enter') {
    editor.dispatchCommand(KEY_ENTER_COMMAND, null);
  } else {
    editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
  }
  return editor.read(() => {
    const selection = $getSelection();
    assert($isRangeSelection(selection) && selection.isCollapsed());
    const node = selection.anchor.getNode();
    return {
      blocks: $getRoot().getChildren().map($describeBlock),
      caret: $getPath($isTextNode(node) ? node.getParentOrThrow() : node),
    };
  });
}

describe('Enter in a shadow root quote', () => {
  test('on a line with text, adds a line to the quote', () => {
    expect(pressKey('Enter', [['a']], [0, 0])).toEqual({
      blocks: [['a', '']],
      caret: [0, 1],
    });
  });

  test('on an empty last line, moves the line after the quote', () => {
    expect(pressKey('Enter', [['a', '']], [0, 1])).toEqual({
      blocks: [['a'], ''],
      caret: [1],
    });
  });

  test('on an empty first line, moves the line before the quote', () => {
    expect(pressKey('Enter', [['', 'b']], [0, 0])).toEqual({
      blocks: ['', ['b']],
      caret: [0],
    });
  });

  test('on an empty line in the middle, splits the quote in two', () => {
    expect(pressKey('Enter', [['a', '', 'b']], [0, 1])).toEqual({
      blocks: [['a'], '', ['b']],
      caret: [1],
    });
  });

  test('on the only line of the quote, an empty one, removes the quote', () => {
    expect(pressKey('Enter', [['']], [0, 0])).toEqual({
      blocks: [''],
      caret: [0],
    });
  });

  test('in a nested quote, moves the line to the outer quote', () => {
    expect(pressKey('Enter', [[['a', '']]], [0, 0, 1])).toEqual({
      blocks: [[['a'], '']],
      caret: [0, 1],
    });
  });
});

describe('Backspace in a shadow root quote', () => {
  test('at the start of the first line, moves only that line out', () => {
    expect(pressKey('Backspace', [['a', 'b']], [0, 0])).toEqual({
      blocks: ['a', ['b']],
      caret: [0],
    });
  });

  test('at the start of the only line, removes the quote', () => {
    expect(pressKey('Backspace', [['a']], [0, 0])).toEqual({
      blocks: ['a'],
      caret: [0],
    });
  });

  test('in a nested quote, moves the line to the outer quote', () => {
    expect(pressKey('Backspace', [[['a', 'b']]], [0, 0, 0])).toEqual({
      blocks: [['a', ['b']]],
      caret: [0, 0],
    });
  });

  test('at the start of the second line, joins it to the first line', () => {
    expect(pressKey('Backspace', [['a', 'b']], [0, 1])).toEqual({
      blocks: [['ab']],
      caret: [0, 0],
    });
  });
});
