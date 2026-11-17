/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A remote change the binding cannot read while its editor composes. The
// hold keeps showing the format items a remote change deleted in the
// composed line, and sets Item.keep on them so that the deleting
// transaction's garbage collection leaves them readable. The failed read is
// recovered by reading the whole document again into a new editor state,
// which ends the hold: the flags are cleared, so a later collection of the
// document's deleted items collects them. Before, the recovery dropped the
// hold with its flags set, and nothing cleared them afterwards (not the end
// of the composition, nor disposing the binding): they stayed exempt for the
// document's lifetime.

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

import {Reader} from '../../../internal/Read';
import {$selectIn, freshReader, setup} from '../../utils/harness';

/** The deleted format items `doc`'s root holds. */
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
  test(`a remote read recovered mid-composition ends the hold: the kept format items can be collected (gc ${gc})`, async () => {
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
    // A cannot read B's next change, once: A reads the whole document again.
    const proto = Reader.prototype as unknown as {
      $apply: (...args: unknown[]) => void;
    };
    const apply = proto.$apply;
    let failed = false;
    proto.$apply = function (this: Reader, ...args: unknown[]) {
      if (!failed) {
        failed = true;
        throw new Error('simulated reader failure');
      }
      return apply.apply(this, args);
    };
    try {
      b.update(() => {
        const n = $getRoot().getAllTextNodes()[0] as TextNode;
        n.setTextContent('ONE' + n.getTextContent().slice(3));
      });
      await t.sync();
    } finally {
      proto.$apply = apply;
    }
    expect(failed).toBe(true);
    expect(a.warnings).toEqual([
      'a remote change could not be read: simulated reader failure',
    ]);
    expect(held.every(it => !it.keep)).toBe(true);
    // A collection of A's deleted items collects them.
    Y.gcIdSet(a.doc, Y.createDeleteSetFromStructStore(a.doc.store));
    for (const it of held) {
      const now = a.doc.store.getItem(it.id);
      expect(
        now instanceof Y.Item ? now.content instanceof Y.ContentFormat : false,
      ).toBe(false);
    }
    // Both peers show what is stored.
    await t.sync();
    expect(a.describe()).toBe('paragraph("ONE two threeX")');
    expect(b.describe()).toBe(a.describe());
    expect((await freshReader(b)).describe()).toBe(b.describe());
    expect(b.warnings.filter(w => /self-check/.test(w))).toEqual([]);
  });
}
