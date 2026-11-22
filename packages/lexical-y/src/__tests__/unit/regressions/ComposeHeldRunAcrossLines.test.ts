/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A composing peer, and a run whose halves are in two lines. B bolds "one
// two" while A composes "k" at the start of the line, and A presses Enter
// after "k": B's run then starts before "k" (in A's composed line, once A
// composes there again) and ends in the next line. The run is then
// removed, in one change (B's undo) or in two, its opener first or its end
// first. The next line reads its own changes as they come; when the
// composed line's hold kept the opener while the end was gone there (now or
// later), the kept opener paired with nothing and its run reached on into
// the next line: A's next write (Enter before "k") stored lines that read
// bold where A's editor shows plain text, and warned `self-check: format
// f:bold at 0`. The hold keeps only runs that lie in the composed line as
// it showed before the change (an item deleted earlier that the hold does
// not keep bounds nothing, though an undo manager keeps it findable); the
// line reads the removal of any other run at once, as it reads any removal
// outside paired runs.

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

import {
  $selectIn,
  expectConverged,
  freshReader,
  type Peer,
  setup,
} from '../../utils/harness';

/** B's bold opener and the end that names it. */
function boldRun(b: Peer): [opener: Y.Item, end: Y.Item] {
  const formats: Y.Item[] = [];
  for (
    let it = b.doc.get('lexical-y')._start;
    it !== null;
    it = it.right as Y.Item | null
  ) {
    if (
      !it.deleted &&
      it.content instanceof Y.ContentFormat &&
      it.content.key === 'f:bold'
    ) {
      formats.push(it);
    }
  }
  const opener = formats.find(
    it => (it.content as Y.ContentFormat).value === true,
  )!;
  const end = formats.find(it => {
    const value = (it.content as Y.ContentFormat).value as unknown;
    return Array.isArray(value) && value.length === 1
      ? it.id.client === opener.id.client &&
          it.id.clock - (value[0] as number) === opener.id.clock
      : Array.isArray(value) &&
          value.length === 2 &&
          value[0] === opener.id.client &&
          value[1] === opener.id.clock;
  })!;
  expect(opener).toBeDefined();
  expect(end).toBeDefined();
  return [opener, end];
}

for (const removal of ['in one change', 'opener first', 'end first']) {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      test(`a composed line holds no half of a run that reaches into the next line: removed ${removal} (gc ${gc}, ids ${ids})`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append($createTextNode('one two three')),
              $createParagraphNode().append($createTextNode('four')),
            ),
          {gc, ids},
        );
        const {a, b} = t;
        // A composes "k" at the start of the line; B bolds "one two".
        let key = '';
        a.update(() => {
          const n = $getRoot().getFirstDescendant() as TextNode;
          key = n.getKey();
          n.select(0, 0);
          $setCompositionKey(key);
        });
        a.update(() => {
          const n = $getNodeByKey(key) as TextNode;
          n.setTextContent('k' + n.getTextContent());
          n.select(1, 1);
        });
        t.offline();
        b.update(() => {
          $selectIn([0], 0, 7);
          ($getSelection() as RangeSelection).formatText('bold');
          $setSelection(null);
        });
        await t.sync();
        // A presses Enter after "k", then ends the composition.
        a.update(() => {
          ($getSelection() as RangeSelection).insertParagraph();
        });
        a.update(() => $setCompositionKey(null));
        await t.sync();
        expect(a.describe()).toBe(b.describe());
        // A composes at "k" again; the run is removed.
        a.update(() => {
          const n = $getRoot().getFirstDescendant() as TextNode;
          key = n.getKey();
          n.select(0, 0);
          $setCompositionKey(key);
        });
        if (removal === 'in one change') {
          b.binding.undo();
          await t.sync();
        } else {
          const [opener, end] = boldRun(b);
          const halves =
            removal === 'opener first' ? [opener, end] : [end, opener];
          for (const half of halves) {
            b.doc.transact(tr => half.delete(tr), 'raw');
            await t.sync();
          }
        }
        // A presses Enter before "k", and ends the composition.
        a.update(() => {
          ($getSelection() as RangeSelection).insertParagraph();
        });
        a.update(() => $setCompositionKey(null));
        await t.sync();
        expect(a.warnings.filter(w => /self-check/.test(w))).toEqual([]);
        await expectConverged(t.peers);
        expect((await freshReader(a)).describe()).toBe(a.describe());
        expect(a.describe()).not.toMatch(/\{1\}/);
      });
    }
  }
}

// A raw writer's bold from "one" into the next line, with a plain gap
// inside "one" whose items are deleted earlier (an app undo manager keeps
// them findable): the gap's deleted closer must not count as ending the
// bold in the composed line when the bold's own items are removed.
for (const gc of [false, true]) {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`a composed line holds no plain value whose effect an earlier deleted item seemed to end (gc ${gc}, ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('one two three')),
            $createParagraphNode().append($createTextNode('four')),
          ),
        {gc, ids},
      );
      const {a, b} = t;
      const receiverUndo = new Y.UndoManager(a.doc, {
        captureTimeout: 0,
        trackedOrigins: new Set([a.net]),
      });
      const root = b.doc.get('lexical-y');
      const flat = root
        .toDelta()
        .children.map(p => {
          const insert = (p as {insert?: unknown}).insert;
          return typeof insert === 'string' ? insert : '\u0001';
        })
        .join('');
      const from = flat.indexOf('one');
      const until = flat.indexOf('four') + 2;
      const insertedBold = (tr: Y.Transaction): Y.Item[] => {
        const out: Y.Item[] = [];
        for (
          let it = root._start;
          it !== null;
          it = it.right as Y.Item | null
        ) {
          if (
            tr.insertSet.hasId(it.id) &&
            it.content instanceof Y.ContentFormat &&
            it.content.key === 'f:bold'
          ) {
            out.push(it);
          }
        }
        return out;
      };
      let outer: Y.Item[] = [];
      b.doc.transact(tr => {
        root.format(from, until - from, {'f:bold': true});
        outer = insertedBold(tr);
      }, 'raw outer');
      expect(outer).toHaveLength(2);
      let inner: Y.Item[] = [];
      b.doc.transact(tr => {
        root.format(from + 3, 1, {'f:bold': null});
        inner = insertedBold(tr);
      }, 'raw inner');
      expect(inner).toHaveLength(2);
      const app = new Y.UndoManager(root, {
        trackedOrigins: new Set(['remove inner']),
      });
      b.doc.transact(tr => inner.forEach(it => it.delete(tr)), 'remove inner');
      await t.sync();
      let key = '';
      a.update(() => {
        const n = $getRoot().getFirstDescendant() as TextNode;
        key = n.getKey();
        n.select(0, 0);
        $setCompositionKey(key);
      });
      a.update(() => {
        const n = $getNodeByKey(key) as TextNode;
        n.setTextContent('k' + n.getTextContent());
        n.select(1, 1);
      });
      await t.sync();
      b.doc.transact(tr => outer.forEach(it => it.delete(tr)), 'remove outer');
      await t.sync();
      expect(a.read(() => $getNodeByKey(key)?.isAttached())).toBe(true);
      a.update(() => ($getSelection() as RangeSelection).insertParagraph());
      a.update(() => $setCompositionKey(null));
      await t.sync();
      expect(a.warnings.filter(w => /self-check/.test(w))).toEqual([]);
      await expectConverged(t.peers);
      expect((await freshReader(a)).describe()).toBe(a.describe());
      app.destroy();
      receiverUndo.destroy();
    });
  }
}

// B's bold with its end removed first (the opener then reaches on, into the
// next line); while A composes in the line, the opener is removed too. The
// end deleted earlier (findable through the document's index of ends and
// A's undo manager) must not count as bounding the opener in the line.
for (const gc of [false, true]) {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`a composed line holds no opener whose end was removed earlier (gc ${gc}, ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('one two three')),
            $createParagraphNode().append($createTextNode('four')),
          ),
        {gc, ids},
      );
      const {a, b} = t;
      const receiverUndo = new Y.UndoManager(a.doc, {
        captureTimeout: 0,
        trackedOrigins: new Set([a.net]),
      });
      b.update(() => {
        $selectIn([0], 0, 7);
        ($getSelection() as RangeSelection).formatText('bold');
        $setSelection(null);
      });
      const formats: Y.Item[] = [];
      for (
        let it = b.doc.get('lexical-y')._start;
        it !== null;
        it = it.right as Y.Item | null
      ) {
        if (
          !it.deleted &&
          it.content instanceof Y.ContentFormat &&
          it.content.key === 'f:bold'
        ) {
          formats.push(it);
        }
      }
      const opener = formats.find(
        it => (it.content as Y.ContentFormat).value === true,
      )!;
      const end =
        formats.find(it =>
          Array.isArray((it.content as Y.ContentFormat).value),
        ) ?? formats.find(it => (it.content as Y.ContentFormat).value === null);
      expect(opener).toBeDefined();
      expect(end).toBeDefined();
      b.doc.transact(tr => end!.delete(tr), 'remove end');
      await t.sync();
      let key = '';
      a.update(() => {
        const n = $getRoot().getFirstDescendant() as TextNode;
        key = n.getKey();
        n.select(0, 0);
        $setCompositionKey(key);
      });
      a.update(() => {
        const n = $getNodeByKey(key) as TextNode;
        n.setTextContent('k' + n.getTextContent());
        n.select(1, 1);
      });
      await t.sync();
      b.doc.transact(tr => opener.delete(tr), 'remove opener');
      await t.sync();
      expect(a.read(() => $getNodeByKey(key)?.isAttached())).toBe(true);
      a.update(() => ($getSelection() as RangeSelection).insertParagraph());
      a.update(() => $setCompositionKey(null));
      await t.sync();
      expect(a.warnings.filter(w => /self-check/.test(w))).toEqual([]);
      await expectConverged(t.peers);
      expect((await freshReader(a)).describe()).toBe(a.describe());
      receiverUndo.destroy();
    });
  }
}
