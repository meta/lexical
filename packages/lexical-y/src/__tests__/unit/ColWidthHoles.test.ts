/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A table whose colWidths holds an undefined width (inserting a column past
// the stored widths leaves one, as does an array with holes). A value with
// an undefined array entry is stored as null, which every reader parses as
// TableNode does (0, as TableNode's own JSON round trip gives too). The
// author's normalization gives its node that value and writes it, so the
// author shows what every reader shows, and the document stores what a
// reader returns (soak S3-10: the author kept `[92,92,null,null]` in its
// JSON against `[92,92,0,0]` everywhere else, for good).

import {
  $createTableNodeWithDimensions,
  $insertTableColumnAtSelection,
  $isTableNode,
  type TableNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $getRoot,
  $isElementNode,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {expect, test} from 'vitest';

import {
  $p,
  expectConverged,
  flush,
  freshReader,
  type Peer,
  setup,
} from '../utils/harness';

const $table = () => $getRoot().getChildren().find($isTableNode) as TableNode;
const widths = (p: Peer) =>
  p.read(() => JSON.stringify($table().getColWidths()));

/** The colWidths the document stores for the table. */
function stored(p: Peer): unknown {
  let found: unknown = 'none';
  const visit = (y: Y.Node) => {
    for (let it = y._start; it !== null; it = it.right) {
      if (!it.deleted && it.content instanceof Y.ContentType) {
        const t = it.content.type as Y.Node;
        const w = t.getAttr('p:colWidths');
        if (w !== undefined) {
          found = w;
        }
        visit(t);
      }
    }
  };
  visit(p.doc.get('lexical-y'));
  return found;
}

for (const how of ['an array with holes', 'a column inserted past them']) {
  for (const meanwhile of ['none', 'a peer types in a cell']) {
    test(`colWidths with an undefined width (${how})${meanwhile === 'none' ? '' : '; meanwhile ' + meanwhile}: the author shows what every reader shows`, async () => {
      const t = await setup(() => {
        $getRoot().append(
          $createTableNodeWithDimensions(2, 4, false),
          $p('end'),
        );
      });
      if (how === 'an array with holes') {
        t.a.update(() => {
          const w: number[] = [92, 92];
          // Two holes.
          w.length = 4;
          $table().setColWidths(w);
        });
      } else {
        t.a.update(() => {
          $table().setColWidths([92, 92]);
        });
        await t.sync();
        t.a.update(() => {
          const row = $assertNodeType(
            $table().getFirstChildOrThrow(),
            $isElementNode,
          );
          $assertNodeType(
            row.getLastChildOrThrow(),
            $isElementNode,
          ).selectEnd();
          $insertTableColumnAtSelection(true);
        });
      }
      if (meanwhile !== 'none') {
        t.offline();
        t.b.update(() => {
          const row = $assertNodeType(
            $table().getFirstChildOrThrow(),
            $isElementNode,
          );
          const cell = $assertNodeType(
            row.getFirstChildOrThrow(),
            $isElementNode,
          );
          (
            $assertNodeType(
              cell.getFirstChildOrThrow(),
              $isElementNode,
            ) as ElementNode
          )
            .selectEnd()
            .insertText('typed');
        });
      }
      await t.sync();
      await flush();
      const fresh = await freshReader(t.a);
      const want = how === 'an array with holes' ? '[92,92,0,0]' : '[92,92,0]';
      expect(widths(t.a)).toBe(want);
      expect(widths(t.b)).toBe(want);
      expect(widths(fresh)).toBe(want);
      // The document stores what readers return.
      expect(JSON.stringify(stored(t.a))).toBe(want);
      for (const p of [...t.peers, fresh]) {
        expect(p.warnings).toEqual([]);
      }
      if (meanwhile !== 'none') {
        expect(
          t.b.read(() =>
            (
              $assertNodeType(
                $assertNodeType(
                  $assertNodeType(
                    $table().getFirstChildOrThrow(),
                    $isElementNode,
                  ).getFirstChildOrThrow(),
                  $isElementNode,
                ).getFirstChildOrThrow(),
                $isElementNode,
              ).getFirstChild() as TextNode | null
            )?.getTextContent(),
          ),
        ).toBe('typed');
      }
      await expectConverged(t.peers);
    });
  }
}
