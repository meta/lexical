/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$insertDataTransferForRichText} from '@lexical/clipboard';
import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {TableExtension} from '@lexical/table';
import {
  $createParagraphNode,
  $getRoot,
  configExtension,
  defineExtension,
  type TextFormatType,
} from 'lexical';
import {expect, test} from 'vitest';

const FORMATS: TextFormatType[] = [
  'bold',
  'italic',
  'underline',
  'strikethrough',
];

// Paste `cells` as one table row of text/html into an empty editor, through
// the default rich-text clipboard handler, and list each text node with the
// formats it ends up with.
function pasteRow(cells: string): string[] {
  using editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: () => {
        $getRoot().append($createParagraphNode());
      },
      dependencies: [
        RichTextExtension,
        configExtension(TableExtension, {hasHorizontalScroll: false}),
      ],
      name: 'paste-cell-style-format',
      onError: e => {
        throw e;
      },
    }),
  );
  const data = new DataTransfer();
  data.setData('text/html', `<table><tr>${cells}</tr></table>`);
  editor.update(
    () => {
      $insertDataTransferForRichText(data, $getRoot().selectEnd());
    },
    {discrete: true},
  );
  return editor.read(() =>
    $getRoot()
      .getAllTextNodes()
      .map(
        node =>
          `${node.getTextContent()}:${FORMATS.filter(format =>
            node.hasFormat(format),
          ).join(',')}`,
      ),
  );
}

test.each([
  ['<td style="font-weight: bold">Total</td>', ['Total:bold']],
  ['<td><b>Total</b></td>', ['Total:bold']],
])('a cell pasted as %s keeps its format', (cells, expected) => {
  expect(pasteRow(cells)).toEqual(expected);
});

// A cell made bold, italic, underlined or struck through by its own style
// adds that format to its text. Text that has the format already, from
// markup inside the cell, keeps it rather than having it toggled off.
test.each([
  ['<td style="font-weight: bold"><b>Total</b></td>', ['Total:bold']],
  ['<td style="font-weight: bold"><strong>Total</strong></td>', ['Total:bold']],
  // Spreadsheet-style rich text: the cell's format on the <td> and each
  // run's full format on its own <span>.
  [
    '<td style="font-weight:bold;"><span style="font-weight:bold;font-style:italic;">ab</span><span style="font-weight:bold;">cd</span></td>',
    ['ab:bold,italic', 'cd:bold'],
  ],
  ['<td style="font-style: italic"><em>x</em></td>', ['x:italic']],
  ['<td style="text-decoration: underline"><u>x</u></td>', ['x:underline']],
  [
    '<td style="text-decoration: line-through"><s>x</s></td>',
    ['x:strikethrough'],
  ],
])(
  'a cell pasted as %s keeps the format its text already has',
  (cells, expected) => {
    expect(pasteRow(cells)).toEqual(expected);
  },
);
