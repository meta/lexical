/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Two clients color ranges of a document with a table (its cells are
// containers of their own) and sync now and then. After every step, no item
// of either document may have a neighbour in another container (see
// misLinkedItems): a write that ended a run after its client's item in
// another container linked its item into the wrong list
// (regressions/CrossContainerEnd.test.ts). Seeds: LEXICAL_Y_STRUCTURE_SEEDS
// (default 200) from LEXICAL_Y_STRUCTURE_FIRST (default 1); LEXICAL_Y_GC=1
// for garbage collection on.

import {buildEditorFromExtensions} from '@lexical/extension';
import {MarkStateExtension} from '@lexical/mark';
import {RichTextExtension} from '@lexical/rich-text';
import {$patchStyleText} from '@lexical/selection';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  TableExtension,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isParagraphNode,
  $setSelection,
  configExtension,
  defineExtension,
  type ElementNode,
  type LexicalNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YCollabExtension} from '../..';
import {seedYState} from '../../headless';
import {misLinkedItems} from '../utils/structure';

const GC = process.env.LEXICAL_Y_GC === '1';
const SEEDS = Number(process.env.LEXICAL_Y_STRUCTURE_SEEDS ?? 200);
const FIRST = Number(process.env.LEXICAL_Y_STRUCTURE_FIRST ?? 1);
const STEPS = 40;
const EXTENSIONS = [RichTextExtension, TableExtension, MarkStateExtension];
const COLORS = ['#c00', '#0a0', '#00c'];

type Op =
  | {k: 'sync'}
  | {k: 'color'; e: number; p: number; a: number; b: number; v: number};

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const SEEDED = seedYState({extensions: EXTENSIONS, schemaVersion: 1}, () => {
  const $cell = (text: string) =>
    $createTableCellNode(0).append(
      $createParagraphNode().append($createTextNode(text)),
    );
  $getRoot()
    .clear()
    .append(
      $createParagraphNode().append($createTextNode('alpha beta gamma')),
      $createTableNode().append(
        $createTableRowNode().append(
          $cell('one two three'),
          $cell('four five six'),
        ),
      ),
      $createParagraphNode().append($createTextNode('delta epsilon zeta')),
    );
});

function $paragraphs(): ElementNode[] {
  const out: ElementNode[] = [];
  const walk = (n: LexicalNode) => {
    if ($isParagraphNode(n)) {
      out.push(n);
    } else if ($isElementNode(n)) {
      n.getChildren().forEach(walk);
    }
  };
  walk($getRoot());
  return out;
}

function $color(op: Extract<Op, {k: 'color'}>) {
  const paragraphs = $paragraphs();
  const texts = paragraphs[op.p % paragraphs.length].getAllTextNodes();
  const total = texts.reduce((n, t) => n + t.getTextContentSize(), 0);
  if (total === 0) {
    return;
  }
  const at = (offset: number) => {
    let left = Math.max(0, Math.min(offset, total));
    for (const t of texts) {
      const n = t.getTextContentSize();
      if (left <= n) {
        return {o: left, t};
      }
      left -= n;
    }
    const last = texts[texts.length - 1];
    return {o: last.getTextContentSize(), t: last};
  };
  const from = Math.min(op.a, total - 1);
  const x = at(from);
  const y = at(op.b >= 99 ? total : Math.min(total, from + op.b));
  const selection = $createRangeSelection();
  selection.anchor.set(x.t.getKey(), x.o, 'text');
  selection.focus.set(y.t.getKey(), y.o, 'text');
  $setSelection(selection);
  $patchStyleText(selection, {color: op.v < 3 ? COLORS[op.v] : null});
  $setSelection(null);
}

function gen(seed: number): Op[] {
  const r = rng(seed * 2654435761 + 5);
  const ops: Op[] = [];
  for (let s = 0; s < STEPS; s++) {
    ops.push({
      a: Math.floor(r() * 14),
      b: r() < 0.35 ? 99 : 1 + Math.floor(r() * 8),
      e: Math.floor(r() * 2),
      k: 'color',
      p: Math.floor(r() * 4),
      v: Math.floor(r() * 4),
    });
    if (r() < 0.6) {
      ops.push({k: 'sync'});
    }
  }
  return ops;
}

for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
  test(`seed ${seed}: no item has a neighbour in another container (gc ${GC ? 'on' : 'off'})`, () => {
    const errors: unknown[] = [];
    // A write the binding refuses is recovered from and only warned about:
    // record the warnings so a failing seed is named.
    const warnings: string[] = [];
    const docs = [0, 1].map(i => {
      const doc = createYDoc(null, {gc: GC});
      doc.clientID = 1001 + i;
      Y.applyUpdate(doc, SEEDED);
      return doc;
    });
    const editors = docs.map((doc, i) =>
      buildEditorFromExtensions(
        defineExtension({
          dependencies: [
            ...EXTENSIONS,
            configExtension(YCollabExtension, {
              doc,
              schemaVersion: 1,
              synced: true,
            }),
          ],
          name: `structure/${i}`,
          onError: e => errors.push(e),
          onWarn: e => warnings.push(String(e && (e as Error).message)),
        }),
      ),
    );
    try {
      for (const [i, op] of gen(seed).entries()) {
        if (op.k === 'sync') {
          Y.applyUpdate(
            docs[1],
            Y.encodeStateAsUpdate(docs[0], Y.encodeStateVector(docs[1])),
          );
          Y.applyUpdate(
            docs[0],
            Y.encodeStateAsUpdate(docs[1], Y.encodeStateVector(docs[0])),
          );
        } else {
          editors[op.e].update(() => $color(op), {discrete: true});
        }
        for (const doc of docs) {
          expect(misLinkedItems(doc), `after step ${i}`).toEqual([]);
        }
        expect(warnings, `after step ${i}`).toEqual([]);
      }
      expect(errors).toEqual([]);
    } finally {
      editors.forEach(e => e.dispose());
      docs.forEach(d => d.destroy());
    }
  });
}
