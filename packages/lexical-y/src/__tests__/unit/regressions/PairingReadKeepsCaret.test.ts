/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// An opener that arrives after an end naming it changes the pairing of what
// lies between them, so the binding reads the whole document again. That
// read gives every line new nodes, and it put no selection back: a peer
// composing in a line the change does not touch was left without a caret
// (its next keystroke went nowhere). B, offline, bolds "one tw"; A starts
// composing at the start of "seven eight"; B, back online, bolds "four f"
// with plain values (a raw writer's); the sync brings both to A. A's caret
// is now put back where it was.

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setCompositionKey,
  type ElementNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {expectConverged, freshReader, setup} from '../../utils/harness';
import {prepareMarkState} from '../../utils/sizeOps';

for (const gc of [false, true]) {
  for (const ids of [
    [1, 2, 3],
    [3, 2, 1],
  ]) {
    test(`a read of the whole document for a pairing change keeps a composing peer's caret (gc ${gc}, ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('one two three')),
            $createParagraphNode().append($createTextNode('four five six')),
            $createParagraphNode().append($createTextNode('seven eight')),
          ),
        {gc, ids, prepare: prepareMarkState},
      );
      const {a, b} = t;
      b.online = false;
      b.update(() => {
        const line = $getRoot().getChildren()[0] as ElementNode;
        line.getAllTextNodes()[0].select(0, 6).formatText('bold');
      });
      a.update(() => {
        const line = $getRoot().getChildren()[2] as ElementNode;
        const text = line.getAllTextNodes()[0];
        text.select(0, 0);
        $setCompositionKey(text.getKey());
      });
      b.online = true;
      b.doc.transact(() =>
        (
          b.doc.get('lexical-y') as unknown as {
            format(at: number, length: number, attrs: object): void;
          }
        ).format(13, 7, {'f:bold': true}),
      );
      await t.sync();
      const caret = a.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return null;
        }
        const node = selection.anchor.getNode();
        return [
          node.getTopLevelElementOrThrow().getIndexWithinParent(),
          node.getTextContent(),
          selection.anchor.offset,
        ];
      });
      expect(caret).toEqual([2, 'seven eight', 0]);
      a.update(() => $setCompositionKey(null));
      await t.sync();
      await expectConverged(t.peers);
      expect((await freshReader(a)).describe()).toBe(a.describe());
      for (const p of t.peers) {
        p.stop();
      }
    });
  }
}
