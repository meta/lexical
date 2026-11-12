/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// B's text left directly in a shadow-root quote (A moves the paragraph into
// the quote while B types into it), which every reader shows as a paragraph
// of its own; then B's follow-up moves the next root paragraph into the
// quote, before its first child, which is refused. The re-read shows what a
// fresh read shows: it reused the moved paragraph for the text left in the
// quote, that paragraph went back to the root, and B lost the text for good
// while A and fresh readers kept it (soak S4-4).

import {$createQuoteNode} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
  type ElementNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  describeNode,
  freshReader,
  type Peer,
  setup,
} from '../utils/harness';

const tree = (p: Peer) =>
  p.read(() => $getRoot().getChildren().map(describeNode).join(' / '));

describe('a refused follow-up re-reads a quote holding text without a paragraph', () => {
  for (const side of ['after', 'before'] as const) {
    for (const next of ['nothing', 'types elsewhere'] as const) {
      test(`text ${side} the quote's paragraph; then the author ${next === 'nothing' ? 'does nothing' : next}`, async () => {
        const t = await setup(() => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('Title')),
            $createParagraphNode().append($createTextNode('t1z ')),
            $createParagraphNode().append($createTextNode('end')),
          );
        });
        t.offline();
        t.a.update(() => {
          const para = $block([1]);
          const quote = $createQuoteNode({shadowRoot: true});
          para.insertBefore(quote);
          quote.append(para);
        });
        t.b.update(() => {
          const sel =
            side === 'before'
              ? $block([1]).selectStart()
              : $block([1]).selectEnd();
          sel.insertText('t5z ');
        });
        await t.sync();
        const both =
          side === 'before'
            ? 'quote(paragraph("t5z ") paragraph("t1z "))'
            : 'quote(paragraph("t1z ") paragraph("t5z "))';
        expect(tree(t.b)).toBe(
          `paragraph("Title") / ${both} / paragraph("end")`,
        );
        t.b.update(() => {
          const quote = $getRoot().getChildAtIndex(1) as ElementNode;
          quote.getFirstChild()!.insertBefore(quote.getNextSibling()!);
          $setSelection(null);
        }, 'block-id-repair');
        // Refused and read again: as a fresh read of the same document.
        expect(tree(t.b)).toBe(tree(await freshReader(t.b)));
        expect(tree(t.b)).toBe(
          `paragraph("Title") / ${both} / paragraph("end")`,
        );
        await t.sync();
        const w = {deleted: ''};
        t.b.doc.on('afterTransaction', (tr: Y.Transaction) => {
          if (!tr.local) {
            return;
          }
          Y.iterateStructsByIdSet(tr, tr.deleteSet, s => {
            if (s instanceof Y.Item && s.content instanceof Y.ContentString) {
              w.deleted += s.content.str;
            }
          });
        });
        if (next === 'types elsewhere') {
          t.b.update(() => {
            $block([0]).selectEnd().insertText('X');
          });
        }
        await t.sync();
        const fresh = await freshReader(t.a);
        expect(w.deleted).toBe('');
        expect(tree(t.b)).toBe(tree(t.a));
        expect(tree(fresh)).toBe(tree(t.a));
        expect(tree(t.a)).toContain(both);
      });
    }
  }
});
