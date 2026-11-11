/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A line left without a marker by concurrent edits (text B typed into the
// last line while A removed it, at the end of the root after a block node;
// or A joining two lines while B puts a widget between them), then an update
// that changes it: empties it, types in it, removes the block node before it
// and empties it, deletes a character. A follow-up (BlockIdExtension's naming
// tag) may set attributes and delete, never insert, and only a marker (an
// insert) keeps such a line as the author shows it: the change is not
// written, and the author reads the document again. It was neither written
// nor refused, so the author showed it while every peer and fresh reader kept
// the old text (soak S4-2). An edit writes it (gives the line a marker).

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
  describeNode,
  freshReader,
  type Peer,
  setup,
  WidgetNode,
} from '../utils/harness';

const tree = (p: Peer) =>
  p.read(() => $getRoot().getChildren().map(describeNode).join(' / '));

async function expectConverged(t: {a: Peer; b: Peer; sync(): Promise<void>}) {
  await t.sync();
  const fresh = await freshReader(t.a);
  expect(tree(t.b)).toBe(tree(t.a));
  expect(tree(fresh)).toBe(tree(t.a));
}

describe('a line without a marker at the end, after a block node', () => {
  for (const block of ['quote', 'widget'] as const) {
    for (const tag of ['block-id-repair', undefined] as const) {
      for (const what of [
        'removes the block and empties the line',
        'removes the block and the line',
        'removes the block',
        'empties the line',
        'types in the line',
      ] as const) {
        test(`${block}: an update${tag ? ' (follow-up)' : ''} ${what}`, async () => {
          const t = await setup(() => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('Title')),
              block === 'quote'
                ? $createQuoteNode({shadowRoot: true}).append(
                    $createParagraphNode().append($createTextNode('q')),
                  )
                : $create(WidgetNode),
              $createParagraphNode().append($createTextNode('two')),
            );
          });
          // A removes the last line while B types into it.
          t.offline();
          t.a.update(() => {
            $block([2]).remove();
            $setSelection(null);
          });
          t.b.update(() => {
            $block([2]).selectEnd().insertText(' XX');
          });
          await t.sync();
          expect(tree(t.a)).toContain('paragraph(" XX")');
          t.a.update(() => {
            const kids = $getRoot().getChildren();
            const line = kids[2] as ElementNode;
            if (what === 'empties the line') {
              line.clear();
            } else if (what === 'types in the line') {
              line.selectEnd().insertText('Y');
            } else {
              kids[1].remove();
              if (what === 'removes the block and empties the line') {
                line.clear();
              } else if (what === 'removes the block and the line') {
                line.remove();
              }
            }
            $setSelection(null);
          }, tag);
          await expectConverged(t);
        });
      }
    }
  }
});

describe('a line without a marker before a widget', () => {
  for (const tag of ['block-id-repair', undefined] as const) {
    for (const what of [
      'types in it',
      'empties it',
      'deletes a character',
      'removes it',
      'removes the widget',
    ] as const) {
      test(`an update${tag ? ' (follow-up)' : ''} ${what}`, async () => {
        const t = await setup(() => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('Title')),
            $createParagraphNode().append($createTextNode('one')),
            $createParagraphNode().append($createTextNode('two')),
          );
        });
        // A joins one and two while B puts a widget between them.
        t.offline();
        t.a.update(() => {
          const one = $block([1]).getFirstChild() as TextNode;
          const two = $block([2]).getFirstChild() as TextNode;
          const sel = $createRangeSelection();
          sel.anchor.set(one.getKey(), 3, 'text');
          sel.focus.set(two.getKey(), 0, 'text');
          $setSelection(sel);
          sel.removeText();
        });
        t.b.update(() => {
          $block([1]).insertAfter($create(WidgetNode));
          $setSelection(null);
        });
        await t.sync();
        t.a.update(() => {
          const line = $block([1]);
          if (what === 'types in it') {
            line.selectEnd().insertText('X');
          } else if (what === 'empties it') {
            line.clear();
          } else if (what === 'deletes a character') {
            const sel = line.selectEnd();
            sel.anchor.offset -= 1;
            sel.removeText();
          } else if (what === 'removes it') {
            line.remove();
          } else {
            line.getNextSibling()!.remove();
          }
          $setSelection(null);
        }, tag);
        await expectConverged(t);
      });
    }
  }
});
