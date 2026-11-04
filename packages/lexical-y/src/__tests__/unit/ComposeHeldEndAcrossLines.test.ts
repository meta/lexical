/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A hold that keeps a run's end whose run reaches past the composed line:
// a canonical color run over "one" and "tw" with a raw unpaired red
// restore inside it; A composes at the start of "two" while a remote change
// deletes the run's end and italicizes "o". When the hold ends, the lines
// after the composed one are read again, so every peer converges, reads as
// a fresh reader does, and no self-check warns (gc off and on, both id
// orders).

import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setCompositionKey,
} from 'lexical';
import {expect, test} from 'vitest';

import {readLayout3Formats, writeLayout3Formats} from '../../internal/Layout3';
import {expectConverged, freshReader, setup} from '../utils/harness';

for (const gc of [false, true]) {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`ending a hold that kept a run's end reads the lines after it again (gc ${gc}, ids ${ids})`, async () => {
      const t = await setup(
        () => {
          for (const text of ['one', 'two', 'three', 'four']) {
            $getRoot().append(
              $createParagraphNode().append($createTextNode(text)),
            );
          }
        },
        {gc, ids},
      );
      const root = t.b.doc.get('lexical-y');
      const flat = root
        .toDelta()
        .children.map(p => {
          const insert = (p as {insert?: unknown}).insert;
          return typeof insert === 'string' ? insert : '\u0001';
        })
        .join('');
      const from = flat.indexOf('one');
      const to = flat.indexOf('two') + 2;
      const values = readLayout3Formats(root).map((m, i) => {
        const value = new Map(m);
        if (i >= from && i < to) value.set('p:style', 'color: blue;');
        return value;
      });
      t.b.doc.transact(
        tr => writeLayout3Formats(tr, root, values),
        'canonical',
      );
      let end: Y.Item | null = null;
      for (let it = root._start; it; it = it.right) {
        if (
          !it.deleted &&
          it.content instanceof Y.ContentFormat &&
          it.content.key === 'p:style' &&
          Array.isArray(it.content.value)
        )
          end = it;
      }
      expect(end).not.toBeNull();
      // A raw insertion leaves an unpaired restore inside the canonical run.
      root.insert(from + 1, 'R', {'p:style': 'color: red;'});
      await t.sync();
      t.a.update(() => {
        const node = $getRoot()
          .getAllTextNodes()
          .find(n => n.getTextContent().includes('tw'))!;
        node.select(0, 0);
        $setCompositionKey(node.getKey());
      });
      t.b.doc.transact(tr => {
        end!.delete(tr);
        root.format(from, 1, {'f:italic': true});
      }, 'remote');
      await t.sync();
      t.a.update(() => $setCompositionKey(null));
      await t.sync();
      await expectConverged(t.peers);
      expect((await freshReader(t.a)).describe()).toBe(t.a.describe());
      expect(t.a.warnings.filter(w => /self-check/.test(w))).toEqual([]);
      expect(t.a.read(() => $getRoot().getTextContent())).toContain('three');
    });
  }
}
