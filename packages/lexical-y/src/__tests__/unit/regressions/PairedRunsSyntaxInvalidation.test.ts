/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Record-independent identity syntax: where an opener is deleted or restored, its pairing changes for
// every line between it and its end, which the change itself need not touch.
// A client that reads by syntax, without the writer's layout 3 record, reads
// those lines again: it converges with the writer and a fresh reader after
// the opener's line is deleted, and after an undo restores it.

import {$addMarkID, $getNodeMarkIDs} from '@lexical/mark';
import * as Y from '@y/y';
import {
  $createRangeSelection,
  $getRoot,
  $setSelection,
  type ElementNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {$p, flush, freshReader, type Peer, setup} from '../../utils/harness';
import {prepareMarkState as prepare} from '../../utils/sizeOps';

/** A peer's lines but the last ("q", whose bold L gets last), with comments. */
const shown = (p: Peer) =>
  p.editor.read(() =>
    ($getRoot().getChildren() as ElementNode[])
      .slice(0, -1)
      .map(line =>
        line
          .getAllTextNodes()
          .map(t => {
            const ids = $getNodeMarkIDs(t);
            return t.getTextContent() + (ids.length > 0 ? `[${ids}]` : '');
          })
          .join('|'),
      )
      .join(' / '),
  );

for (const gc of [false, true]) {
  for (const remove of ['first line', 'first word'] as const) {
    test(`a comment over three lines: deleting its start (${remove}) and undoing it converge without the record (gc ${gc ? 'on' : 'off'})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $p('t1z t2z'),
            $p('t3z t4z'),
            $p('t5z t6z'),
            $p('q'),
          ),
        {delivery: 'sender', gc, ids: [1, 2], prepare},
      );
      const [l, r] = t.peers;
      // R's first paired write records layout 3 (on "q"): withheld from L.
      r.update(() => {
        const q = (
          $getRoot().getLastChildOrThrow() as ElementNode
        ).getAllTextNodes()[0];
        q.select(0, 1).formatText('bold');
        $setSelection(null);
      });
      const withheld = (l.pending.get(r) ?? []).slice();
      l.pending.set(r, []);
      // R comments from "t1z" to "t6z".
      r.update(() => {
        const lines = $getRoot().getChildren() as ElementNode[];
        const first = lines[0].getAllTextNodes()[0];
        const last = lines[2].getAllTextNodes()[0];
        const sel = $createRangeSelection();
        sel.anchor.set(first.getKey(), 0, 'text');
        sel.focus.set(last.getKey(), last.getTextContentSize(), 'text');
        $addMarkID('c1', sel);
        $setSelection(null);
      });
      r.binding.undoManager?.stopCapturing();
      // R deletes the comment's start.
      r.update(() => {
        const lines = $getRoot().getChildren() as ElementNode[];
        if (remove === 'first line') {
          lines[0].remove();
        } else {
          lines[0].getAllTextNodes()[0].select(0, 4).removeText();
        }
        $setSelection(null);
      });
      await flush();
      const deliver = () => {
        const list = l.pending.get(r) ?? [];
        l.pending.set(r, []);
        for (const u of list) {
          Y.applyUpdate(l.doc, u, l.net);
        }
      };
      deliver();
      await flush();
      expect(shown(l)).toBe(shown(r));
      expect(shown(l)).toContain('[c1]');
      expect((await freshReader(l)).describe()).toBe(l.describe());
      // R undoes the deletion: the opener is restored.
      r.binding.undoManager!.undo();
      await flush();
      deliver();
      await flush();
      expect(shown(l)).toBe(shown(r));
      expect((await freshReader(l)).describe()).toBe(l.describe());
      // The withheld record arrives: nothing changes.
      for (const u of withheld) {
        Y.applyUpdate(l.doc, u, l.net);
      }
      await flush();
      await t.sync();
      expect(l.describe()).toBe(r.describe());
    });
  }
}
