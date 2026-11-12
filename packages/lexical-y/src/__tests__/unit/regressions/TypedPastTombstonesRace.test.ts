/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Text typed at the end of a code highlight token whose run is followed by
// tombstones (format items a highlight type change wrote and its reversal
// deleted), while another client gives the token a new segment (its node
// replaced: a new opener before it, a new end after it). Both writers step
// over the tombstones (as Yjs does), so their items have the same origin and
// the client ids decide whether the typed text lands inside the new run or
// past its end (found by a randomized multi-client session).
//
// An accepted limit (DECISIONS D105), a consistent structural difference:
// where the end sorts first, the typed text reads as a second code highlight
// node on every peer and in every fresh read (convergent), where main reads
// one. It renders the same (both nodes are highlight tokens of the same
// type), but code that inspects the document sees two nodes, and without a
// highlighter the split stays; an installed code highlighter re-segments the
// line on its next transform of that code block.
// Stopping before the tombstones fixed this cell but put typed text on the
// wrong side of a closer an undo brings back
// (UndoRestoredCloserTypedPlain), so the writer keeps Yjs's placement.

import {$createCodeHighlightNode, $createCodeNode} from '@lexical/code';
import {$getRoot, type ElementNode, type TextNode} from 'lexical';
import {expect, test} from 'vitest';

import {expectConverged, freshReader, setup} from '../../utils/harness';

for (const gc of [false, true]) {
  for (const ids of [
    [17, 10],
    [10, 17],
  ]) {
    // The end sorts first when the re-segmenting client's id is lower.
    const t1 = ids[0] > ids[1] ? test.fails : test;
    t1(
      `typed at a token's end past tombstones ‖ the token re-segmented (gc ${gc}, ids ${ids.join('/')})`,
      async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createCodeNode('plain').append(
                $createCodeHighlightNode('let x = 1;'),
              ),
            ),
          {gc, ids},
        );
        const $token = () =>
          (
            $getRoot().getFirstChild() as ElementNode
          ).getFirstChild() as TextNode;
        // Tombstones after the token's text: a highlight type given and taken
        // back.
        t.a.update(() => {
          (
            $token().getWritable() as unknown as {__highlightType: string}
          ).__highlightType = 'comment';
        });
        await t.sync();
        t.a.update(() => {
          (
            $token().getWritable() as unknown as {__highlightType: unknown}
          ).__highlightType = undefined;
        });
        await t.sync();
        // Concurrently: A types at the token's end; B replaces the token with
        // an equal one (a new segment).
        t.offline();
        t.a.update(() => {
          const n = $token();
          n.setTextContent(n.getTextContent() + ' y');
        });
        t.b.update(() => {
          const n = $token();
          n.replace($createCodeHighlightNode(n.getTextContent()));
        });
        await t.sync();
        await expectConverged(t.peers);
        const fresh = await freshReader(t.a);
        expect(fresh.describe()).toBe(t.a.describe());
        expect(
          t.a.read(() =>
            ($getRoot().getFirstChild() as ElementNode).getChildrenSize(),
          ),
        ).toBe(1);
        expect(t.a.warnings.filter(w => /self-check/.test(w))).toEqual([]);
        fresh.binding.dispose();
      },
    );
  }
}
