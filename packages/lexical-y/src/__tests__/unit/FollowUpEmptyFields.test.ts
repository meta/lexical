/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

/**
 * A follow-up that sets an attribute on an EMPTY
 * paragraph (root, table cell, callout, quote).
 */
import {$createLinkNode} from '@lexical/link';
import {$createListItemNode, $createListNode} from '@lexical/list';
import {$createQuoteNode} from '@lexical/rich-text';
import {
  $createTableNodeWithDimensions,
  type TableCellNode,
  type TableNode,
  type TableRowNode,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
  type ElementNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $createBoxNode,
  $createEquation,
  freshReader,
  type Peer,
  setup,
} from '../utils/harness';

const json = (p: Peer) => JSON.stringify(p.editor.getEditorState().toJSON());

const SETS: Record<string, (e: ElementNode) => void> = {
  direction: e => e.setDirection('rtl'),
  format: e => e.setFormat('center'),
  indent: e => e.setIndent(1),
  textFormat: e => e.setTextFormat(12),
  textStyle: e => e.setTextStyle('color: red'),
};

const WHERE: Record<string, () => ElementNode> = {
  'a link then text': () => $getRoot().getChildAtIndex(9) as ElementNode,
  callout: () =>
    (
      $getRoot().getChildAtIndex(3) as ElementNode
    ).getFirstChild() as ElementNode,
  'empty list item': () =>
    (
      $getRoot().getChildAtIndex(10) as ElementNode
    ).getFirstChild() as ElementNode,
  'only a link': () => $getRoot().getChildAtIndex(6) as ElementNode,
  'only an inline decorator': () =>
    $getRoot().getChildAtIndex(7) as ElementNode,
  quote: () =>
    (
      $getRoot().getChildAtIndex(4) as ElementNode
    ).getFirstChild() as ElementNode,
  'root, last line': () => $getRoot().getLastChild() as ElementNode,
  'root, middle line': () => $getRoot().getChildAtIndex(1) as ElementNode,
  'table cell': () =>
    (
      (
        (
          $getRoot().getChildAtIndex(2) as TableNode
        ).getFirstChild() as TableRowNode
      ).getFirstChild() as TableCellNode
    ).getFirstChild() as ElementNode,
  'text then a link': () => $getRoot().getChildAtIndex(8) as ElementNode,
};

describe('a follow-up that sets an attribute on an empty paragraph', () => {
  // An empty list item too (a line with no text below it).
  for (const where of Object.keys(WHERE)) {
    for (const attr of Object.keys(SETS)) {
      for (const tag of ['block-id-repair', undefined] as const) {
        test(`${where}: ${attr}${tag ? ' (follow-up)' : ''}`, async () => {
          const t = await setup(() => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('Title')),
              $createParagraphNode(),
              $createTableNodeWithDimensions(1, 1, false),
              $createBoxNode('info').append($createParagraphNode()),
              $createQuoteNode({shadowRoot: true}).append(
                $createParagraphNode(),
              ),
              $createParagraphNode(),
              $createParagraphNode().append(
                $createLinkNode('https://x.example').append(
                  $createTextNode('link'),
                ),
              ),
              $createParagraphNode().append($createEquation('e1')),
              $createParagraphNode().append(
                $createTextNode('x '),
                $createLinkNode('https://x.example').append(
                  $createTextNode('link'),
                ),
              ),
              $createParagraphNode().append(
                $createLinkNode('https://x.example').append(
                  $createTextNode('link'),
                ),
                $createTextNode(' y'),
              ),
              $createListNode('bullet').append(
                $createListItemNode(),
                $createListItemNode().append($createTextNode('i2')),
              ),
              $createParagraphNode(),
            );
          });
          t.b.update(() => {
            SETS[attr](WHERE[where]());
            $setSelection(null);
          }, tag);
          const author = json(t.b);
          await t.sync();
          const fresh = await freshReader(t.b);
          expect(json(fresh)).toBe(author);
          expect(json(t.a)).toBe(author);
        });
      }
    }
  }
});
