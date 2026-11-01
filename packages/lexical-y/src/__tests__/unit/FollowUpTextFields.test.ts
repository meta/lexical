/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A follow-up (BlockIdExtension's naming tag) that sets the text format or
// style of an element that is not a line: a wrapper list item, a nested
// list, a callout (directly, or by formatting text from the end of an item
// into the nested list). A follow-up does not write an element's text format
// or style (Lexical's reconciler derives them from the first text on each
// client that renders it), so the change is read again, as any change a
// follow-up does not write. It was neither written nor read again: the
// author kept it while every reader showed none (soak S4-5). An edit writes
// it. The same for any field of a line left without a marker (text typed
// into the last line while a collaborator removes it) and of the paragraph
// a read shows around text left directly in a quote (typed into a paragraph
// a collaborator moved into the quote), which keep them nowhere: a re-read
// shows that paragraph as a fresh read does.

import {
  $createListItemNode,
  $createListNode,
  type ListItemNode,
  type ListNode,
} from '@lexical/list';
import {$createQuoteNode} from '@lexical/rich-text';
import {
  $create,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $createBoxNode,
  freshReader,
  type Peer,
  setup,
  WidgetNode,
} from '../utils/harness';

const json = (p: Peer) => JSON.stringify(p.editor.getEditorState().toJSON());

const $items = () => ($getRoot().getChildAtIndex(1) as ListNode).getChildren();
const $wrapper = () => $items()[2] as ListItemNode;

const CHANGES: Record<string, () => void> = {
  'a callout textFormat': () =>
    ($getRoot().getChildAtIndex(2) as ElementNode).setTextFormat(8),
  'a nested list textFormat': () =>
    ($wrapper().getFirstChild() as ElementNode).setTextFormat(8),
  'a wrapper item textFormat': () => $wrapper().setTextFormat(8),
  'a wrapper item textStyle': () => $wrapper().setTextStyle('color: red'),
  'underline from the end of an item into the nested list': () => {
    const a = ($items()[1] as ElementNode).getFirstChild() as TextNode;
    const b = (
      ($wrapper().getFirstChild() as ElementNode).getFirstChild() as ElementNode
    ).getFirstChild() as TextNode;
    const sel = $createRangeSelection();
    sel.anchor.set(a.getKey(), a.getTextContentSize(), 'text');
    sel.focus.set(b.getKey(), 0, 'text');
    $setSelection(sel);
    sel.formatText('underline');
  },
};

describe('a follow-up that sets the text format of an element that is not a line', () => {
  for (const [name, change] of Object.entries(CHANGES)) {
    for (const tag of ['block-id-repair', undefined] as const) {
      test(`${name}${tag ? ' (follow-up)' : ''}`, async () => {
        const t = await setup(() => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('Title')),
            $createListNode('bullet').append(
              $createListItemNode().append($createTextNode('t6z')),
              $createListItemNode().append($createTextNode('t7z ')),
              $createListItemNode().append(
                $createListNode('bullet').append(
                  $createListItemNode().append($createTextNode('t8z')),
                ),
              ),
            ),
            $createBoxNode('info').append(
              $createParagraphNode().append($createTextNode('b1')),
            ),
          );
        });
        t.b.update(() => {
          change();
          $setSelection(null);
        }, tag);
        const author = json(t.b);
        await t.sync();
        const fresh = await freshReader(t.b);
        expect(json(fresh)).toBe(author);
        expect(json(t.a)).toBe(author);
        if (tag === undefined) {
          expect(author).toMatch(/"text(Format|Style)":("color: red"|8)/);
        }
      });
    }
  }
});

const SETS: Record<string, (e: ElementNode) => void> = {
  direction: e => e.setDirection('rtl'),
  format: e => e.setFormat('center'),
  indent: e => e.setIndent(1),
  textFormat: e => e.setTextFormat(8),
  textStyle: e => e.setTextStyle('color: red'),
};

describe('a follow-up that sets a field of a line without a marker or of a paragraph shown around text in a quote', () => {
  for (const unit of [
    'the line without a marker',
    'the paragraph in the quote',
  ] as const) {
    for (const [field, set] of Object.entries(SETS)) {
      for (const tag of ['block-id-repair', undefined] as const) {
        test(`${unit}: ${field}${tag ? ' (follow-up)' : ''}`, async () => {
          const t = await setup(() => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('Title')),
              $createParagraphNode().append($createTextNode('t1z ')),
              $createParagraphNode().append($createTextNode('end')),
            );
          });
          t.offline();
          if (unit === 'the line without a marker') {
            t.a.update(() => {
              $getRoot().getLastChild()!.remove();
              $getRoot().getChildAtIndex(1)!.insertAfter($create(WidgetNode));
              $setSelection(null);
            });
            t.b.update(() => {
              ($getRoot().getLastChild() as ElementNode)
                .selectEnd()
                .insertText(' XX');
            });
          } else {
            t.a.update(() => {
              const para = $block([1]);
              const quote = $createQuoteNode({shadowRoot: true});
              para.insertBefore(quote);
              quote.append(para);
            });
            t.b.update(() => {
              $block([1]).selectStart().insertText('t5z ');
            });
          }
          await t.sync();
          t.b.update(() => {
            set(
              unit === 'the line without a marker'
                ? ($getRoot().getLastChild() as ElementNode)
                : ((
                    $getRoot().getChildAtIndex(1) as ElementNode
                  ).getFirstChild() as ElementNode),
            );
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
