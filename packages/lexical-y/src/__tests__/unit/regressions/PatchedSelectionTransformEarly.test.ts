/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// TextNode's own selectionTransform patched before the binding's module
// loads (this file patches it, then imports the binding): the patched method
// is what the binding finds, and still counts as app code, so an edit it
// makes in the update of a remote change's read is written.

import {
  $getEditor,
  $getRoot,
  $hasUpdateTag,
  $setSelection,
  type BaseSelection,
  COLLABORATION_TAG,
  type LexicalEditor,
  type RangeSelection,
  TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

const original = TextNode.prototype.selectionTransform;
let target: LexicalEditor | null = null;
let ran = false;
function $patched(
  this: TextNode,
  prevSelection: BaseSelection | null,
  nextSelection: RangeSelection,
): void {
  if (
    !ran &&
    target !== null &&
    $getEditor() === target &&
    $hasUpdateTag(COLLABORATION_TAG)
  ) {
    ran = true;
    const text = $getRoot().getAllTextNodes()[0];
    text.spliceText(3, 0, 'X');
    text.select(4, 4);
  }
  original.call(this, prevSelection, nextSelection);
}
TextNode.prototype.selectionTransform = $patched;

for (const gc of [false, true]) {
  test(`an edit in TextNode's selectionTransform patched before the binding loads (gc ${gc})`, async () => {
    const {$createParagraphNode, $createTextNode} = await import('lexical');
    const {expectConverged, freshReader, setup} =
      await import('../../utils/harness');
    ran = false;
    const t = await setup(
      () =>
        $getRoot().append(
          $createParagraphNode().append($createTextNode('abc')),
          $createParagraphNode().append($createTextNode('other')),
        ),
      {gc, ids: [1, 2, 3]},
    );
    try {
      const {a, c} = t;
      a.update(() => {
        $getRoot().getAllTextNodes()[0].select(3, 3);
      });
      await t.sync();
      target = a.editor;
      c.update(() => {
        $getRoot()
          .getAllTextNodes()
          .find(n => n.getTextContent() === 'other')!
          .spliceText(5, 0, '!');
        $setSelection(null);
      });
      await t.sync();
      target = null;
      expect(ran).toBe(true);
      for (const p of t.peers) {
        expect(p.read(() => $getRoot().getTextContent())).toContain('abcX');
      }
      expect(t.a.describe()).toBe((await freshReader(t.a)).describe());
      await expectConverged(t.peers);
    } finally {
      t.peers.forEach(p => p.stop());
    }
  });
}
