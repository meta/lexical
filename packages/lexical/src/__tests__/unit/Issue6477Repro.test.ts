/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {$insertDataTransferForRichText} from '@lexical/clipboard';
import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {$createLinkNode, LinkNode} from '@lexical/link';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $createTestDecoratorNode,
  $createTestInlineElementNode,
  invariant,
  TestDecoratorNode,
  TestInlineElementNode,
} from '../utils';

const ext = defineExtension({
  dependencies: [RichTextExtension],
  name: '[6477]',
  nodes: [LinkNode, TestDecoratorNode, TestInlineElementNode],
});

/** A compact `type("text")` outline of the node tree. */
function describeTree(node: LexicalNode): string {
  if (!$isElementNode(node)) {
    return `${node.getType()}("${node.getTextContent()}")`;
  }
  return `${node.getType()}(${node.getChildren().map(describeTree).join(' ')})`;
}

function $pasteHTML(editor: LexicalEditor, html: string): void {
  const selection = $getSelection();
  invariant($isRangeSelection(selection), 'Expected a RangeSelection');
  const dataTransfer = new DataTransfer();
  dataTransfer.setData('text/html', html);
  $insertDataTransferForRichText(dataTransfer, selection, editor);
}

// A custom inline ElementNode does not implement insertNewAfter(), so it can
// not be split. Content inserted with the caret inside it used to land after
// the whole node instead of at the caret.
describe('Insertion into a custom inline ElementNode (#6477)', () => {
  test('pasted text is inserted at the caret inside the node', () => {
    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const inner = $createTextNode('abcd');
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('before'),
              $createTestInlineElementNode().append(inner),
              $createTextNode('after'),
            ),
          );
        inner.select(2, 2);
      },
      {discrete: true},
    );
    editor.update(() => $pasteHTML(editor, '<b>XYZ</b>'), {discrete: true});
    editor.read(() => {
      expect(describeTree($getRoot())).toBe(
        'root(paragraph(text("before") test_inline_block(text("ab") text("XYZ") text("cd")) text("after")))',
      );
    });
  });

  test('an inline node inserted at the caret goes inside the node', () => {
    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const inner = $createTextNode('abcd');
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTestInlineElementNode().append(inner),
            ),
          );
        inner.select(2, 2);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const selection = $getSelection();
        invariant($isRangeSelection(selection), 'Expected a RangeSelection');
        selection.insertNodes([$createTestDecoratorNode()]);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect(describeTree($getRoot())).toBe(
        'root(paragraph(test_inline_block(text("ab") test_decorator("Hello world") text("cd"))))',
      );
    });
  });

  // Control: a LinkNode implements insertNewAfter(), so it is split around the
  // pasted content. This assertion holds both with and without the fix.
  test('control: a splittable inline ElementNode is still split', () => {
    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const inner = $createTextNode('abcd');
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createLinkNode('https://lexical.dev').append(inner),
            ),
          );
        inner.select(2, 2);
      },
      {discrete: true},
    );
    editor.update(() => $pasteHTML(editor, '<b>XYZ</b>'), {discrete: true});
    editor.read(() => {
      expect(describeTree($getRoot())).toBe(
        'root(paragraph(link(text("ab")) text("XYZ") link(text("cd"))))',
      );
    });
  });
});
