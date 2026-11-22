/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A stored format run that crosses a block node and a line's marker (as
// concurrent edits leave them: a comment over a callout, closed after it and
// opened again before the next line's marker, running on over the lines
// after). Deleting the block node and the line after it in one update deleted
// the opener the remaining lines relied on: the writer diffed from the end
// of the line before with the formats in effect after the block node, so the
// opener looked redundant. Every reader lost the format there, and the
// author kept it (soak S3-6). A follow-up's delete (an app's deletion that
// Lexical merges into BlockIdExtension's naming commit) did the same, and so
// did its write of a line it emptied after a deleted block node: they
// started from the formats in effect after the deleted units (R12B-C1).

import {
  $getRoot,
  $isElementNode,
  $isTextNode,
  type ElementNode,
  type LexicalNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $p,
  expectConverged,
  freshReader,
  type Peer,
  setup,
  WidgetNode,
} from '../utils/harness';

/** Every line's text runs, bold ones in brackets. */
function runs(peer: Peer): string[] {
  return peer.read(() =>
    $getRoot()
      .getChildren()
      .map((block: LexicalNode) =>
        $isElementNode(block)
          ? (block as ElementNode)
              .getChildren()
              .filter($isTextNode)
              .map(t =>
                t.hasFormat('bold')
                  ? `[${t.getTextContent()}]`
                  : t.getTextContent(),
              )
              .join('')
          : block.getType(),
      ),
  );
}

describe('a stored format run across a block node and a marker', () => {
  for (const [how, tag] of [
    ['', undefined],
    // What BlockIdExtension's naming commit is tagged with: a follow-up.
    [' in a follow-up', 'block-id-repair'],
  ] as const) {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      test(`deleting the block node and the line after it${how} keeps it on the lines after (ids ${ids})`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $p('A'),
              new WidgetNode(),
              $p('Rehabix'),
              $p('Rebifex'),
              $p('end'),
            ),
          {ids},
        );
        // An outside writer leaves the shape: bold opened before the widget and
        // closed after it, and opened again before "Rehabix"'s marker, running
        // over "Rebifex". Content: A ¶ W Rehabix ¶ Rebifex ¶ end ¶.
        const root = t.a.doc.get('lexical-y');
        t.a.doc.transact(() => {
          root.format(2, 1, {'f:bold': true});
          root.format(10, 8, {'f:bold': true});
        }, 'outside');
        await t.sync();
        const before = ['A', 'test_widget', 'Rehabix', '[Rebifex]', 'end'];
        expect(runs(t.a)).toEqual(before);
        expect(runs(t.b)).toEqual(before);
        // A deletes the widget and the line after it.
        t.a.update(() => {
          $getRoot().getChildAtIndex(1)!.remove();
          $getRoot().getChildAtIndex(1)!.remove();
        }, tag);
        await t.sync();
        const after = ['A', '[Rebifex]', 'end'];
        expect(runs(t.a)).toEqual(after);
        // The other client and a fresh reader showed "Rebifex" plain here.
        expect(runs(t.b)).toEqual(after);
        expect(runs(await freshReader(t.a))).toEqual(after);
        await expectConverged(t.peers);
      });

      // Bold opened before the widget runs over the line after it and on
      // over "end". Deleting the widget and emptying that line writes the
      // line from the end of "A" (in a follow-up, on its own).
      test(`deleting the block node and emptying the line after it${how} keeps it on the lines after (ids ${ids})`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $p('A'),
              new WidgetNode(),
              $p('Rehabax'),
              $p('end'),
            ),
          {ids},
        );
        // Content: A ¶ W Rehabax ¶ end ¶; bold over the widget, "Rehabax",
        // its marker and "end".
        const root = t.a.doc.get('lexical-y');
        t.a.doc.transact(() => {
          root.format(2, 12, {'f:bold': true});
        }, 'outside');
        await t.sync();
        const before = ['A', 'test_widget', '[Rehabax]', '[end]'];
        expect(runs(t.a)).toEqual(before);
        expect(runs(t.b)).toEqual(before);
        t.a.update(() => {
          $getRoot().getChildAtIndex(1)!.remove();
          ($getRoot().getChildAtIndex(1) as ElementNode).clear();
        }, tag);
        await t.sync();
        const after = ['A', '', '[end]'];
        expect(runs(t.a)).toEqual(after);
        expect(runs(t.b)).toEqual(after);
        expect(runs(await freshReader(t.a))).toEqual(after);
        await expectConverged(t.peers);
      });
    }
  }
});
