/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$insertDataTransferForRichText} from '@lexical/clipboard';
import {$createCodeNode, CodeExtension} from '@lexical/code';
import {$createCodeHighlightNode, $isCodeNode} from '@lexical/code-core';
import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createLineBreakNode,
  $createTabNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTabNode,
  $isTextNode,
  KEY_ENTER_COMMAND,
  PASTE_COMMAND,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, it} from 'vitest';

describe('CodeExtension', () => {
  it('should not escape code block when content has consecutive blank lines (paste scenario)', () => {
    const ext = defineExtension({
      $initialEditorState: () => {
        const codeNode = $createCodeNode('javascript');
        codeNode.append(
          $createCodeHighlightNode('line1'),
          $createLineBreakNode(),
          $createLineBreakNode(),
          $createLineBreakNode(),
          $createCodeHighlightNode('line2'),
        );
        $getRoot().append(codeNode);
      },
      dependencies: [CodeExtension, RichTextExtension],
      name: '[root]',
    });

    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const root = $getRoot();
        expect(root.getChildrenSize()).toBe(1);
        expect($isCodeNode(root.getFirstChildOrThrow())).toBe(true);
      },
      {discrete: true},
    );
  });

  it('should escape code block on Enter when cursor is after two trailing blank lines', () => {
    const ext = defineExtension({
      $initialEditorState: () => {
        const codeNode = $createCodeNode('javascript');
        codeNode.append(
          $createCodeHighlightNode('hello'),
          $createLineBreakNode(),
          $createLineBreakNode(),
        );
        $getRoot().append(codeNode);
      },
      dependencies: [CodeExtension, RichTextExtension],
      name: '[root-escape]',
    });

    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const codeNode = $assertNodeType(
          $getRoot().getFirstChild(),
          $isCodeNode,
        );
        codeNode.select(codeNode.getChildrenSize(), codeNode.getChildrenSize());
      },
      {discrete: true},
    );

    editor.dispatchCommand(
      KEY_ENTER_COMMAND,
      new KeyboardEvent('keydown', {key: 'Enter'}),
    );

    editor.update(
      () => {
        const root = $getRoot();
        expect(root.getChildrenSize()).toBe(2);
        expect($isCodeNode(root.getFirstChildOrThrow())).toBe(true);
        const secondChild = root.getLastChildOrThrow();
        expect($isElementNode(secondChild)).toBe(true);
        expect(secondChild.getType()).toBe('paragraph');
      },
      {discrete: true},
    );
  });

  it('should not escape code block on Enter with only one trailing blank line', () => {
    const ext = defineExtension({
      $initialEditorState: () => {
        const codeNode = $createCodeNode('javascript');
        codeNode.append(
          $createCodeHighlightNode('hello'),
          $createLineBreakNode(),
        );
        $getRoot().append(codeNode);
      },
      dependencies: [CodeExtension, RichTextExtension],
      name: '[root-one-blank]',
    });

    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const codeNode = $assertNodeType(
          $getRoot().getFirstChild(),
          $isCodeNode,
        );
        codeNode.select(codeNode.getChildrenSize(), codeNode.getChildrenSize());
      },
      {discrete: true},
    );

    editor.dispatchCommand(
      KEY_ENTER_COMMAND,
      new KeyboardEvent('keydown', {key: 'Enter'}),
    );

    editor.update(
      () => {
        const root = $getRoot();
        expect(root.getChildrenSize()).toBe(1);
        expect($isCodeNode(root.getFirstChildOrThrow())).toBe(true);
      },
      {discrete: true},
    );
  });

  it('should strip format from TabNode inside CodeNode', () => {
    const ext = defineExtension({
      $initialEditorState: () => {
        const codeNode = $createCodeNode('javascript');
        codeNode.append($createCodeHighlightNode('x'), $createTabNode());
        $getRoot().append(codeNode);
      },
      dependencies: [CodeExtension, RichTextExtension],
      name: '[tab-format]',
    });
    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const codeNode = $assertNodeType(
          $getRoot().getFirstChild(),
          $isCodeNode,
        );
        $assertNodeType(codeNode.getLastChild(), $isTabNode).setFormat(1);
      },
      {discrete: true},
    );
    editor.read(() => {
      const codeNode = $assertNodeType($getRoot().getFirstChild(), $isCodeNode);
      const tab = $assertNodeType(codeNode.getLastChild(), $isTabNode);
      expect(tab.getFormat()).toBe(0);
    });
  });

  it('should not escape code block on Enter when cursor is not at the end', () => {
    const ext = defineExtension({
      $initialEditorState: () => {
        const codeNode = $createCodeNode('javascript');
        codeNode.append(
          $createCodeHighlightNode('hello'),
          $createLineBreakNode(),
          $createLineBreakNode(),
          $createCodeHighlightNode('world'),
        );
        $getRoot().append(codeNode);
      },
      dependencies: [CodeExtension, RichTextExtension],
      name: '[root-middle]',
    });

    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const codeNode = $assertNodeType(
          $getRoot().getFirstChild(),
          $isCodeNode,
        );
        codeNode.select(1, 1);
      },
      {discrete: true},
    );

    editor.dispatchCommand(
      KEY_ENTER_COMMAND,
      new KeyboardEvent('keydown', {key: 'Enter'}),
    );

    editor.update(
      () => {
        const root = $getRoot();
        expect(root.getChildrenSize()).toBe(1);
        expect($isCodeNode(root.getFirstChildOrThrow())).toBe(true);
      },
      {discrete: true},
    );
  });

  // Without a highlighter a code block holds plain TextNodes, and the
  // indentation they start with is kept on Enter as a CodeHighlightNode's is.
  it.each([
    [
      'a CodeHighlightNode',
      () => [$createCodeHighlightNode('    run();')],
      '    run();',
      '    ',
      'code-highlight',
    ],
    [
      'a TextNode',
      () => [$createTextNode('    run();')],
      '    run();',
      '    ',
      'text',
    ],
    [
      'a tab and a TextNode',
      () => [$createTabNode(), $createTextNode('  run();')],
      '\t  run();',
      '\t  ',
      'text',
    ],
  ])(
    'Enter keeps the indentation of a line of %s',
    (_, $createLine, line, indent, indentType) => {
      const ext = defineExtension({
        $initialEditorState: () => {
          $getRoot().append(
            $createCodeNode('javascript').append(...$createLine()),
          );
        },
        dependencies: [CodeExtension, RichTextExtension],
        name: '[root-indent]',
      });

      using editor = buildEditorFromExtensions(ext);
      editor.update(
        () => {
          $getRoot().selectEnd();
        },
        {discrete: true},
      );

      editor.dispatchCommand(
        KEY_ENTER_COMMAND,
        new KeyboardEvent('keydown', {key: 'Enter'}),
      );

      editor.read(() => {
        const codeNode = $assertNodeType(
          $getRoot().getFirstChild(),
          $isCodeNode,
        );
        expect(codeNode.getTextContent()).toBe(`${line}\n${indent}`);
        const last = codeNode.getLastChildOrThrow();
        expect(last.getType()).toBe(indentType);
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected a RangeSelection');
        expect(selection.isCollapsed()).toBe(true);
        expect(selection.anchor.key).toBe(last.getKey());
        expect(selection.anchor.offset).toBe(last.getTextContentSize());
      });
    },
  );

  // Only the indentation before the caret is copied: with the caret at the
  // start of a line or inside its indentation, the rest of the line moves to
  // the new line with the indentation it has.
  it.each([
    [
      'a CodeHighlightNode',
      0,
      () => $createCodeHighlightNode('    run();'),
      '\n    run();',
    ],
    [
      'a CodeHighlightNode',
      2,
      () => $createCodeHighlightNode('    run();'),
      '  \n    run();',
    ],
    ['a TextNode', 0, () => $createTextNode('    run();'), '\n    run();'],
  ])(
    'Enter in a line of %s at offset %i copies no indentation after the caret',
    (_, offset, $createLine, expected) => {
      const ext = defineExtension({
        $initialEditorState: () => {
          $getRoot().append(
            $createCodeNode('javascript').append($createLine()),
          );
        },
        dependencies: [CodeExtension, RichTextExtension],
        name: '[root-indent-caret]',
      });

      using editor = buildEditorFromExtensions(ext);
      editor.update(
        () => {
          const line = $getRoot().getFirstDescendant();
          assert($isTextNode(line), 'Expected a TextNode');
          line.select(offset, offset);
        },
        {discrete: true},
      );

      editor.dispatchCommand(
        KEY_ENTER_COMMAND,
        new KeyboardEvent('keydown', {key: 'Enter'}),
      );

      editor.read(() => {
        expect($getRoot().getTextContent()).toBe(expected);
      });
    },
  );

  // A paste inserts its text as written: each pasted line keeps its own
  // indentation and gets none from the line above.
  it.each([
    ['an empty code block', () => [], ''],
    [
      'the end of an indented line of a TextNode',
      () => [$createTextNode('    let x = 1;')],
      '    let x = 1;',
    ],
    [
      'the end of an indented line of a CodeHighlightNode',
      () => [$createCodeHighlightNode('    let x = 1;')],
      '    let x = 1;',
    ],
  ])(
    'a paste into %s keeps each pasted line as written',
    (_, $createLine, line) => {
      const pasted = '\nif (x) {\n  run();\n    stop();\n}';
      const ext = defineExtension({
        $initialEditorState: () => {
          $getRoot().append(
            $createCodeNode('javascript').append(...$createLine()),
          );
        },
        dependencies: [CodeExtension, RichTextExtension],
        name: '[root-paste]',
      });

      using editor = buildEditorFromExtensions(ext);
      editor.update(
        () => {
          $getRoot().selectEnd();
        },
        {discrete: true},
      );

      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', pasted);
      editor.dispatchCommand(
        PASTE_COMMAND,
        new ClipboardEvent('paste', {clipboardData}),
      );

      editor.read(() => {
        expect($getRoot().getTextContent()).toBe(`${line}${pasted}`);
      });
    },
  );

  // Text inserted line by line outside a paste, as a drop does, is in plain
  // TextNodes that bring their own indentation.
  it('text inserted line by line outside a paste keeps each line as written', () => {
    const inserted = 'if (x) {\n  run();\n    stop();\n}';
    const ext = defineExtension({
      $initialEditorState: () => {
        $getRoot().append($createCodeNode('javascript'));
      },
      dependencies: [CodeExtension, RichTextExtension],
      name: '[root-insert]',
    });

    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const dataTransfer = new DataTransfer();
        dataTransfer.setData('text/plain', inserted);
        $insertDataTransferForRichText(
          dataTransfer,
          $getRoot().selectEnd(),
          editor,
        );
      },
      {discrete: true},
    );

    editor.read(() => {
      expect($getRoot().getTextContent()).toBe(inserted);
    });
  });
});
