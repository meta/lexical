/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A line the composer splits while it composes (Enter, an IME's Enter that
// does not commit) is still the line being composed: both halves show what
// the hold shows, and only what they hand on to the next lines is stored.
// C colors part of A's line red while A composes there (held back); C's raw
// writer then writes an end naming that red opener in the line before. A
// presses Enter: the new half started with the red the hold holds back
// when the end's arrival read it as an ordinary line, and A's next write
// warned `self-check: format p:style at 0`. The halves of a split line now
// keep their shown start; the stored one is kept for the release.

import {$patchStyleText} from '@lexical/selection';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setCompositionKey,
  $setSelection,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {expect, onTestFinished, test} from 'vitest';

import {freshReader, type Peer, setup} from '../../utils/harness';
import {prepareMarkState} from '../../utils/sizeOps';

type Root = {
  format(at: number, length: number, attrs: object): void;
};

const root = (p: Peer) => p.doc.get('lexical-y') as unknown as Root;

/** Select [l0:o0, l1:o1] (lines and offsets in their text). */
function $select(l0: number, o0: number, l1: number, o1: number) {
  const lines = $getRoot().getChildren() as ElementNode[];
  const point = (li: number, o: number): [TextNode, number] => {
    let at = o;
    const texts = lines[li].getAllTextNodes();
    for (const t of texts) {
      if (at <= t.getTextContentSize()) {
        return [t, at];
      }
      at -= t.getTextContentSize();
    }
    const last = texts[texts.length - 1];
    return [last, last.getTextContentSize()];
  };
  const [a, ao] = point(l0, o0);
  const [b, bo] = point(l1, o1);
  const selection = $createRangeSelection();
  selection.anchor.set(a.getKey(), ao, 'text');
  selection.focus.set(b.getKey(), bo, 'text');
  $setSelection(selection);
  return selection;
}

/** Live format items of `key` in `p`'s document, with the characters before. */
function formatItems(p: Peer, key: string): {it: Y.Item; pos: number}[] {
  const out: {it: Y.Item; pos: number}[] = [];
  let pos = 0;
  for (
    let it = p.doc.get('lexical-y')._start;
    it !== null;
    it = it.right as Y.Item | null
  ) {
    if (
      !it.deleted &&
      it.content instanceof Y.ContentFormat &&
      it.content.key === key
    ) {
      out.push({it, pos});
    }
    if (!it.deleted && it.countable) {
      pos += it.length;
    }
  }
  return out;
}

const nearest = (items: {it: Y.Item; pos: number}[], pos: number) =>
  items.reduce((x, y) =>
    Math.abs(y.pos - pos) < Math.abs(x.pos - pos) ? y : x,
  ).it;

for (const ids of [
  [1, 2, 3],
  [3, 2, 1],
]) {
  test(`the halves of a line split while composing show the held start (ids ${ids})`, async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createParagraphNode().append($createTextNode('one two three')),
          $createParagraphNode().append($createTextNode('four five six')),
          $createParagraphNode().append($createTextNode('seven eight')),
        ),
      {gc: true, ids, prepare: prepareMarkState},
    );
    const {a, b, c} = t;
    const host = document.createElement('div');
    host.contentEditable = 'true';
    document.body.append(host);
    a.editor.setRootElement(host);
    onTestFinished(() => {
      a.editor.setRootElement(null);
      host.remove();
      for (const p of t.peers) {
        p.stop();
      }
    });
    b.update(() => {
      $select(1, 5, 2, 4).formatText('italic');
      $setSelection(null);
    });
    c.update(() => {
      $patchStyleText($select(2, 1, 2, 5), {color: 'blue'});
      $setSelection(null);
    });
    let key = '';
    a.update(() => {
      const selection = $select(2, 9, 2, 9);
      const node = selection.anchor.getNode();
      key = node.getKey();
      $setCompositionKey(key);
    });
    c.update(() => {
      $patchStyleText($select(2, 0, 2, 8), {color: 'red'});
      $setSelection(null);
    });
    b.doc.transact(() => root(b).format(8, 2, {'f:bold': true}));
    a.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        const node = selection.anchor.getNode() as TextNode;
        const at = selection.anchor.offset;
        const text = node.getTextContent();
        node.setTextContent(text.slice(0, at) + ' ' + text.slice(at));
        node.select(at + 1, at + 1);
      }
    });
    // C deletes a bold end, and writes an end naming the red opener in the
    // line before (a raw writer's).
    const ends = formatItems(c, 'f:bold').filter(
      x =>
        Array.isArray((x.it.content as Y.ContentFormat).value) ||
        (x.it.content as Y.ContentFormat).value === null,
    );
    if (ends.length > 0) {
      const end = nearest(ends, 28);
      c.doc.transact(tr => end.delete(tr));
    }
    const openers = formatItems(c, 'p:style').filter(
      x =>
        !Array.isArray((x.it.content as Y.ContentFormat).value) &&
        (x.it.content as Y.ContentFormat).value !== null,
    );
    const opener = nearest(openers, 16);
    c.doc.transact(() =>
      root(c).format(20, 1, {
        'p:style': [opener.id.client, opener.id.clock],
      }),
    );
    a.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        selection.insertParagraph();
      }
    });
    expect(a.warnings.filter(w => w.includes('self-check'))).toEqual([]);
    a.update(() => $setCompositionKey(null));
    await t.sync();
    const derived = (w: string) =>
      /self-check(?: \(remote\))?: container root\[\d+\]\.text(Format|Style):/.test(
        w,
      );
    for (const p of t.peers) {
      p.warnings = p.warnings.filter(w => !derived(w));
      expect(p.warnings.filter(w => w.includes('self-check'))).toEqual([]);
    }
    expect((await freshReader(a)).describe()).toBe(a.describe());
    expect((await freshReader(b)).describe()).toBe(b.describe());
    expect(b.describe()).toBe(a.describe());
  });
}
