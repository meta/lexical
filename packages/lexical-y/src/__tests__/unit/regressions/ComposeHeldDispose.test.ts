/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A binding disposed while its editor composes. The hold keeps showing the
// format items a remote change deleted in the composed line, and sets
// Item.keep on them so that the deleting transaction's garbage collection
// leaves them readable. Disposing the binding ends the hold: the flags are
// cleared, so a later collection of the document's deleted items collects
// them. Before, only the end of a composition cleared them, and a binding
// disposed mid-composition left them exempt for the document's lifetime.
// Disposing writes nothing, and the other peers are unaffected.

import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $setCompositionKey,
  $setSelection,
  type RangeSelection,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {$selectIn, freshReader, setup} from '../../utils/harness';

/** The deleted format items `doc`'s root holds, with whether they are kept. */
function deletedFormats(doc: Y.Doc): Y.Item[] {
  const out: Y.Item[] = [];
  for (
    let it = doc.get('lexical-y')._start;
    it !== null;
    it = it.right as Y.Item | null
  ) {
    if (it.deleted && it.content instanceof Y.ContentFormat) {
      out.push(it);
    }
  }
  return out;
}

for (const gc of [false, true]) {
  test(`disposing a binding mid-composition ends its hold: the kept format items can be collected, nothing is written (gc ${gc})`, async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createParagraphNode().append($createTextNode('one two three')),
        ),
      {gc, ids: [1, 2]},
    );
    const {a, b} = t;
    b.update(() => {
      $selectIn([0], 4, 7);
      ($getSelection() as RangeSelection).formatText('bold');
      $setSelection(null);
    });
    await t.sync();
    // A composes at the end of the line.
    let key = '';
    a.update(() => {
      const n = $getRoot().getAllTextNodes().at(-1) as TextNode;
      key = n.getKey();
      const at = n.getTextContent().length;
      n.select(at, at);
      $setCompositionKey(key);
    });
    a.update(() => {
      const n = $getNodeByKey(key) as TextNode;
      n.setTextContent(n.getTextContent() + 'X');
    });
    // B unbolds "two": its paired run is deleted, and A's hold keeps it.
    b.update(() => {
      const two = $getRoot()
        .getAllTextNodes()
        .find(n => n.getTextContent() === 'two') as TextNode;
      two.setFormat(0);
    });
    await t.sync();
    const held = deletedFormats(a.doc).filter(it => it.keep);
    expect(held.length).toBeGreaterThan(0);
    // A's binding is disposed while A still composes.
    const before = Y.encodeStateAsUpdate(a.doc);
    a.binding.dispose();
    expect(Buffer.from(Y.encodeStateAsUpdate(a.doc))).toEqual(
      Buffer.from(before),
    );
    expect(held.every(it => !it.keep)).toBe(true);
    // A collection of A's deleted items collects them.
    Y.gcIdSet(a.doc, Y.createDeleteSetFromStructStore(a.doc.store));
    for (const it of held) {
      const now = a.doc.store.getItem(it.id);
      expect(
        now instanceof Y.Item ? now.content instanceof Y.ContentFormat : false,
      ).toBe(false);
    }
    // The other peers are unaffected.
    await t.sync();
    expect(b.describe()).toBe('paragraph("one two threeX")');
    expect((await freshReader(b)).describe()).toBe(b.describe());
    expect(b.warnings.filter(w => /self-check/.test(w))).toEqual([]);
  });
}
