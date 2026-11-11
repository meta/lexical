/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Applying another client's update inside one of the binding's own write
// transactions (a beforeTransaction handler of the app's) is unsupported:
// Yjs merges it into that transaction, which the binding does not read as a
// remote change. Development builds report another client's insertions
// there once per binding.

import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
  type ParagraphNode,
  type TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

import {type Peer, setup} from '../../utils/harness';

const REMOTE_IN_WRITE = "applied inside the binding's own write transaction";

describe("another client's update applied inside the binding's write transaction", () => {
  test('development builds warn once per binding', async () => {
    const t = await setup(() =>
      $getRoot().append(
        $createParagraphNode().append($createTextNode('abc')),
        $createParagraphNode().append($createTextNode('separator')),
      ),
    );
    onTestFinished(() => t.peers.forEach((p: Peer) => p.stop()));
    const {a, b} = t;
    t.offline();
    b.update(() => {
      (
        (
          $getRoot().getFirstChildOrThrow() as ParagraphNode
        ).getFirstChild() as TextNode
      ).spliceText(3, 0, 'Q');
      $setSelection(null);
    });
    const remote = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc));
    let armed = true;
    const inside = (tr: Y.Transaction) => {
      if (armed && tr.origin === a.binding) {
        armed = false;
        Y.applyUpdate(a.doc, remote);
      }
    };
    a.doc.on('beforeTransaction', inside);
    onTestFinished(() => a.doc.off('beforeTransaction', inside));
    for (const text of ['x', 'y']) {
      a.update(() => {
        (
          (
            $getRoot().getLastChildOrThrow() as ParagraphNode
          ).getFirstChild() as TextNode
        ).spliceText(0, 0, text);
        $setSelection(null);
      });
      armed = true;
    }
    expect(a.warnings.filter(w => w.includes(REMOTE_IN_WRITE))).toHaveLength(1);
    expect(b.warnings.filter(w => w.includes(REMOTE_IN_WRITE))).toEqual([]);
  });

  test('an update applied outside it is not reported', async () => {
    const t = await setup(() =>
      $getRoot().append(
        $createParagraphNode().append($createTextNode('abc')),
        $createParagraphNode().append($createTextNode('separator')),
      ),
    );
    onTestFinished(() => t.peers.forEach((p: Peer) => p.stop()));
    const {a, b} = t;
    b.update(() => {
      (
        (
          $getRoot().getFirstChildOrThrow() as ParagraphNode
        ).getFirstChild() as TextNode
      ).spliceText(3, 0, 'Q');
      $setSelection(null);
    });
    await t.sync();
    a.update(() => {
      (
        (
          $getRoot().getLastChildOrThrow() as ParagraphNode
        ).getFirstChild() as TextNode
      ).spliceText(0, 0, 'x');
      $setSelection(null);
    });
    await t.sync();
    expect(a.read(() => $getRoot().getTextContent())).toContain('abcQ');
    for (const p of t.peers) {
      expect(p.warnings.filter(w => w.includes(REMOTE_IN_WRITE))).toEqual([]);
    }
  });
});
