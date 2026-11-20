/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$insertDataTransferForRichText} from '@lexical/clipboard';
import {HistoryExtension} from '@lexical/history';
import {$isListItemNode, ListExtension} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isParagraphNode,
  configExtension,
  defineExtension,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  UNDO_COMMAND,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

import {buildEditorFromExtensions, TabIndentationExtension} from '../../index';

// Pasted content must respect maxIndent too, not only the indent command
// (#5170). Indent command caps indentation at maxIndent - 1.
function createEditor(
  maxIndent: null | number,
  $canIndent?: (node: ElementNode) => boolean,
) {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        RichTextExtension,
        ListExtension,
        HistoryExtension,
        configExtension(
          TabIndentationExtension,
          $canIndent ? {$canIndent, maxIndent} : {maxIndent},
        ),
      ],
      name: 'IndentationLimitsPaste',
    }),
  );
}

function paste(editor: LexicalEditor, html: string) {
  editor.update(
    () => {
      const paragraph = $createParagraphNode();
      $getRoot().clear().append(paragraph);
      paragraph.select();
    },
    {discrete: true},
  );
  editor.update(
    () => {
      const selection = $getSelection();
      assert(selection !== null, 'Expected a selection');
      const dataTransfer = {
        getData: (type: string) => (type === 'text/html' ? html : ''),
        types: ['text/html'],
      } as unknown as DataTransfer;
      $insertDataTransferForRichText(dataTransfer, selection, editor);
    },
    {discrete: true},
  );
}

function $blocks(
  node: LexicalNode = $getRoot(),
): {indent: number; text: string; type: string}[] {
  if ($isListItemNode(node) && $isElementNode(node.getFirstChild())) {
    return node.getChildren().flatMap(child => $blocks(child));
  }
  if (
    $isElementNode(node) &&
    !node.isInline() &&
    node
      .getChildren()
      .every(child => !$isElementNode(child) || child.isInline())
  ) {
    return node.getTextContent() === ''
      ? []
      : [
          {
            indent: node.getIndent(),
            text: node.getTextContent(),
            type: node.getType(),
          },
        ];
  }
  return $isElementNode(node)
    ? node.getChildren().flatMap(child => $blocks(child))
    : [];
}

function nestedListHTML(depth: number): string {
  let html = '';
  for (let i = depth; i >= 0; i--) {
    html = `<ul><li>level ${i}</li>${html ? `<li>${html}</li>` : ''}</ul>`;
  }
  return html;
}

const indentedBlocksHTML =
  '<p data-lexical-indent="2">two</p>' +
  '<p data-lexical-indent="10">ten</p>' +
  '<h1 data-lexical-indent="9">heading</h1>';

describe('TabIndentationExtension maxIndent on paste (#5170)', () => {
  test('clamps an over-indented initial editor state', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          $getRoot().append(
            $createParagraphNode().setIndent(1).append($createTextNode('one')),
            $createParagraphNode().setIndent(9).append($createTextNode('nine')),
          );
        },
        dependencies: [
          RichTextExtension,
          configExtension(TabIndentationExtension, {maxIndent: 4}),
        ],
        name: 'IndentationLimitsInitialState',
      }),
    );
    expect(editor.read(() => $blocks())).toEqual([
      {indent: 1, text: 'one', type: 'paragraph'},
      {indent: 3, text: 'nine', type: 'paragraph'},
    ]);
  });

  test('clamps an over-indented state set with setEditorState', () => {
    using editor = createEditor(4);
    const json = JSON.stringify({
      root: {
        children: [
          {
            children: [
              {
                detail: 0,
                format: 0,
                mode: 'normal',
                style: '',
                text: 'deep',
                type: 'text',
                version: 1,
              },
            ],
            direction: null,
            format: '',
            indent: 7,
            type: 'paragraph',
            version: 1,
          },
        ],
        direction: null,
        format: '',
        indent: 0,
        type: 'root',
        version: 1,
      },
    });
    editor.setEditorState(editor.parseEditorState(json));
    expect(editor.read(() => $blocks())).toEqual([
      {indent: 3, text: 'deep', type: 'paragraph'},
    ]);
  });

  test('clamps a pasted nested list without losing items', () => {
    using editor = createEditor(4);
    paste(editor, nestedListHTML(6));
    expect(editor.read(() => $blocks())).toEqual(
      [0, 1, 2, 3, 3, 3, 3].map((indent, i) => ({
        indent,
        text: `level ${i}`,
        type: 'listitem',
      })),
    );
  });

  test('clamps pasted indented paragraphs and headings', () => {
    using editor = createEditor(4);
    paste(editor, indentedBlocksHTML);
    expect(editor.read(() => $blocks())).toEqual([
      {indent: 2, text: 'two', type: 'paragraph'},
      {indent: 3, text: 'ten', type: 'paragraph'},
      {indent: 3, text: 'heading', type: 'heading'},
    ]);
  });

  test('leaves pasted indentation alone when maxIndent is null', () => {
    using editor = createEditor(null);
    paste(editor, nestedListHTML(6) + indentedBlocksHTML);
    expect(editor.read(() => $blocks().map(({indent}) => indent))).toEqual([
      0, 1, 2, 3, 4, 5, 6, 2, 10, 9,
    ]);
  });

  test('only clamps nodes that the $canIndent predicate allows to indent', () => {
    using editor = createEditor(4, node => !$isParagraphNode(node));
    paste(editor, indentedBlocksHTML);
    expect(editor.read(() => $blocks().map(({indent}) => indent))).toEqual([
      2, 10, 3,
    ]);
  });

  test('clamps in the same history entry as the paste', () => {
    using editor = createEditor(4);
    paste(editor, indentedBlocksHTML);
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    expect(editor.read(() => $getRoot().getTextContent())).toBe('');
  });
});
