/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$createCodeNode, $isCodeNode, CodeIndentExtension} from '@lexical/code';
import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createLineBreakNode,
  $createRangeSelection,
  $createTabNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isLineBreakNode,
  $isRangeSelection,
  $isTabNode,
  $setSelection,
  configExtension,
  defineExtension,
  KEY_TAB_COMMAND,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import {assert, describe, expect, it} from 'vitest';

// Without a highlighter, a code block holds plain TextNodes rather than
// CodeHighlightNodes. CodeIndentExtension supports that setup, but Tab with
// a selection and Shift+Tab threw "Expected selection to be inside CodeBlock
// and consisting of CodeHighlightNode, TabNode and LineBreakNode".

function buildEditor(
  lines: (() => LexicalNode[])[],
  // [text node index, offset] of the anchor and the focus, counting TabNodes
  anchor: [number, number],
  focus: [number, number] = anchor,
  tabSize?: number,
) {
  return buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: () => {
        const code = $createCodeNode();
        lines.forEach(($createLine, i) => {
          if (i > 0) {
            code.append($createLineBreakNode());
          }
          code.append(...$createLine());
        });
        $getRoot().append(code);
        const textNodes = code.getAllTextNodes();
        const selection = $createRangeSelection();
        selection.anchor.set(textNodes[anchor[0]].getKey(), anchor[1], 'text');
        selection.focus.set(textNodes[focus[0]].getKey(), focus[1], 'text');
        $setSelection(selection);
      },
      dependencies: [
        tabSize === undefined
          ? CodeIndentExtension
          : configExtension(CodeIndentExtension, {tabSize}),
        RichTextExtension,
      ],
      name: '[code-indent-without-highlighter]',
    }),
  );
}

function pressTab(editor: LexicalEditor, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    cancelable: true,
    key: 'Tab',
    shiftKey,
  });
  editor.dispatchCommand(KEY_TAB_COMMAND, event);
  return event;
}

function $getCodeChildren(): LexicalNode[] {
  const code = $getRoot().getFirstChildOrThrow();
  assert($isCodeNode(code), 'expected a CodeNode');
  return code.getChildren();
}

function $getCodeText(): string {
  return $getCodeChildren()
    .map(node => node.getTextContent())
    .join('');
}

// Whether every line of the code block starts with a TabNode.
function $everyLineStartsWithATab(): boolean {
  const children = $getCodeChildren();
  return children.every((node, i) =>
    i === 0 || $isLineBreakNode(children[i - 1]) ? $isTabNode(node) : true,
  );
}

describe('CodeIndentExtension without a highlighter', () => {
  it('indents every selected line with Tab', () => {
    using editor = buildEditor(
      [() => [$createTextNode('one')], () => [$createTextNode('two')]],
      [0, 0],
      [1, 3],
    );

    const event = pressTab(editor);

    expect(event.defaultPrevented).toBe(true);
    editor.read(() => {
      expect($getCodeText()).toBe('\tone\n\ttwo');
      expect($everyLineStartsWithATab()).toBe(true);
      // The selection still spans both lines, now from the first new tab.
      const selection = $getSelection();
      assert($isRangeSelection(selection), 'expected a RangeSelection');
      const children = $getCodeChildren();
      expect([selection.anchor.key, selection.anchor.offset]).toEqual([
        children[0].getKey(),
        0,
      ]);
      expect([selection.focus.key, selection.focus.offset]).toEqual([
        children[4].getKey(),
        3,
      ]);
    });
  });

  it('outdents every selected line with Shift+Tab', () => {
    using editor = buildEditor(
      [
        () => [$createTabNode(), $createTextNode('one')],
        () => [$createTabNode(), $createTextNode('two')],
      ],
      [1, 0],
      [3, 3],
    );

    pressTab(editor, true);

    editor.read(() => {
      expect($getCodeText()).toBe('one\ntwo');
    });
  });

  it('outdents the line of a collapsed caret with Shift+Tab', () => {
    using editor = buildEditor(
      [() => [$createTabNode(), $createTextNode('one')]],
      [1, 1],
    );

    pressTab(editor, true);

    editor.read(() => {
      expect($getCodeText()).toBe('one');
    });
  });

  // A caret at offset 0 of a line ends the selection at the start of that
  // line, so $getCodeLines drops it and the line is outdented at the caret.
  it('outdents the line of a caret at its start with Shift+Tab', () => {
    using editor = buildEditor(
      [() => [$createTabNode(), $createTextNode('one')]],
      [1, 0],
    );

    pressTab(editor, true);

    editor.read(() => {
      expect($getCodeText()).toBe('one');
    });
  });

  it('strips leading spaces at a caret at the start of the line when tabSize is configured', () => {
    using editor = buildEditor(
      [() => [$createTextNode('    one')]],
      [0, 0],
      [0, 0],
      2,
    );

    pressTab(editor, true);

    editor.read(() => {
      expect($getCodeText()).toBe('  one');
    });
  });

  it('strips leading spaces with Shift+Tab when tabSize is configured', () => {
    using editor = buildEditor(
      [() => [$createTextNode('    one')]],
      [0, 6],
      [0, 6],
      2,
    );

    pressTab(editor, true);

    editor.read(() => {
      expect($getCodeText()).toBe('  one');
    });
  });

  it('indents a line made of several text nodes from its first node', () => {
    using editor = buildEditor(
      [
        () => [$createTextNode('a').toggleFormat('bold'), $createTextNode('b')],
        () => [$createTextNode('c')],
      ],
      [1, 0],
      [2, 1],
    );

    pressTab(editor);

    editor.read(() => {
      expect($getCodeText()).toBe('\tab\n\tc');
      expect($everyLineStartsWithATab()).toBe(true);
    });
  });
});
