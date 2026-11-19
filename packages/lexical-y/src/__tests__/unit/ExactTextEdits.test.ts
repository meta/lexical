/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// While the binding is attached, Lexical records the text edits of an update
// with their offsets (EditorState#_textEdits): the writer writes those edits
// where they were made, rather than a diff of the old and new text, which
// cannot tell where an insert or a delete next to equal text was made. A diff
// is anchored by the caret, so an edit made without one (an agent's or app
// code's edit, or typing in an update that then moves the caret or makes
// another edit) was written shifted: `t5z ` typed before `t4z` was written as
// `5z t` inserted after the `t` of `t4z`, and a peer's concurrent delete of
// that `t` took the typed word's letter (soak S4-9).

import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  type ElementNode,
  type TextFormatType,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {type Peer, setup} from '../utils/harness';

const $line = (n: number) => $getRoot().getChildAtIndex(n) as ElementNode;
const lineText = (p: Peer) => p.read(() => $line(1).getTextContent());

/** The ids of the shared items of line `n`'s characters, in order. */
function lineIds(p: Peer, n: number): string[] {
  const lines: string[][] = [[]];
  const root = p.binding.root as unknown as {_start: Y.Item | null};
  for (let it = root._start; it !== null; it = it.right) {
    if (it.deleted || !it.countable) {
      continue;
    }
    if (it.content instanceof Y.ContentString) {
      for (let k = 0; k < it.length; k++) {
        lines[lines.length - 1].push(`${it.id.client}:${it.id.clock + k}`);
      }
    } else if (it.content instanceof Y.ContentType) {
      lines.push([]);
    }
  }
  return lines[n];
}

/** The text node and offset at `at` of line 1's text. */
function $at(at: number, start: boolean): [TextNode, number] {
  const texts = $line(1).getAllTextNodes();
  let pos = 0;
  for (let i = 0; i < texts.length; i++) {
    const size = texts[i].getTextContentSize();
    if (
      (start ? at < pos + size : at <= pos + size) ||
      i === texts.length - 1
    ) {
      return [texts[i], at - pos];
    }
    pos += size;
  }
  throw new Error('no text');
}

const AFTER = [
  'caret kept',
  'caret cleared',
  'caret moved to the title',
  'another edit after',
] as const;

function $after(after: (typeof AFTER)[number]) {
  const title = $line(0).getFirstChild() as TextNode;
  if (after === 'caret cleared') {
    $setSelection(null);
  } else if (after === 'caret moved to the title') {
    title.select(2, 2);
  } else if (after === 'another edit after') {
    title.select(5, 5).insertText('!');
  }
}

describe('typing before an equal-starting word, the caret moved away in the same update (S4-9)', () => {
  for (const after of AFTER) {
    test(after, async () => {
      const t = await setup(() => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('Title')),
          $createParagraphNode().append($createTextNode('t3z t4z ')),
        );
      });
      const before = lineIds(t.a, 1);
      t.offline();
      t.a.update(() => {
        ($line(1).getFirstChild() as TextNode).select(4, 4).insertText('t5z ');
        $after(after);
      });
      // Written where it was typed: the old characters keep their items.
      const ids = lineIds(t.a, 1);
      expect(ids.slice(0, 4)).toEqual(before.slice(0, 4));
      expect(ids.slice(8)).toEqual(before.slice(4));
      // B deletes "z t4z" (the end of t3z and the next word) at the same time.
      t.b.update(() => {
        const tn = $line(1).getFirstChild() as TextNode;
        const s = $createRangeSelection();
        s.anchor.set(tn.getKey(), 2, 'text');
        s.focus.set(tn.getKey(), 7, 'text');
        $setSelection(s);
        s.removeText();
        $setSelection(null);
      });
      await t.sync();
      expect(lineText(t.a)).toBe('t3t5z  ');
      expect(lineText(t.b)).toBe(lineText(t.a));
    });
  }
});

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

const WORDS = ['t3z ', 't4z ', 'la ', 'la la ', 'aa', 'a ', 'ab', 'tt', ' '];

// Seeded inserts and deletes (one or two in an update) next to equal text,
// through the selection or spliceText, the caret then cleared, moved or used
// for another edit: every old character keeps its item, deleted ones are the
// ones deleted, and inserted text is new.
describe('inserts and deletes next to equal text without a caret', () => {
  const n = Number(process.env.EXACT_EDIT_SEEDS ?? 300);
  test(`${n} seeded edits`, async () => {
    const fails: string[] = [];
    for (let seed = 1; seed <= n; seed++) {
      const r = rng(seed);
      const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)];
      const nodes: [string, TextFormatType | null][] = [];
      const k = 1 + Math.floor(r() * 3);
      for (let i = 0; i < k; i++) {
        nodes.push([
          pick(WORDS) + (r() < 0.6 ? pick(WORDS) : ''),
          i % 2 === 1 ? pick(['bold', 'italic'] as TextFormatType[]) : null,
        ]);
      }
      const t = await setup(() => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('Title')),
          $createParagraphNode().append(
            ...nodes.map(([s, f]) => {
              const x = $createTextNode(s);
              if (f !== null) {
                x.toggleFormat(f);
              }
              return x;
            }),
          ),
        );
      });
      const before = lineIds(t.a, 1);
      let text = lineText(t.a);
      const how = pick(['selection', 'spliceText'] as const);
      const after = pick(AFTER.slice(1));
      // [at, deleted, inserted] on the line's text, in order.
      const edits: [number, number, string][] = [];
      const count = r() < 0.25 ? 2 : 1;
      for (let e = 0; e < count; e++) {
        if (r() < 0.5 || text.length < 2) {
          const at = Math.floor(r() * (text.length + 1));
          const len = 1 + Math.floor(r() * 4);
          const ins =
            pick([
              text.slice(Math.max(0, at - len), at),
              text.slice(at, at + len),
              pick(WORDS),
              text.slice(at).replace(/^t\d/, 't5'),
            ]) || pick(WORDS);
          edits.push([at, 0, ins]);
          text = text.slice(0, at) + ins + text.slice(at);
        } else {
          const at = Math.floor(r() * (text.length - 1));
          const del = 1 + Math.floor(r() * Math.min(4, text.length - at - 1));
          edits.push([at, del, '']);
          text = text.slice(0, at) + text.slice(at + del);
        }
      }
      let ok = true;
      t.a.update(() => {
        for (const [at, del, ins] of edits) {
          if (del > 0) {
            const [a, ao] = $at(at, true);
            const [f, fo] = $at(at + del, false);
            if (how === 'spliceText' && a.is(f)) {
              a.spliceText(ao, del, '');
            } else {
              const s = $createRangeSelection();
              s.anchor.set(a.getKey(), ao, 'text');
              s.focus.set(f.getKey(), fo, 'text');
              $setSelection(s);
              s.removeText();
            }
          } else {
            const [node, o] = $at(at, false);
            if (how === 'spliceText') {
              node.spliceText(o, 0, ins);
            } else {
              node.select(o, o).insertText(ins);
            }
          }
        }
        $after(after);
      });
      if (lineText(t.a) !== text) {
        // An edit Lexical made otherwise (not this test's subject).
        ok = false;
      }
      const model: (string | null)[] = before.slice();
      for (const [at, del, ins] of edits) {
        model.splice(at, del, ...new Array<null>(ins.length).fill(null));
      }
      const ids = lineIds(t.a, 1);
      const old = new Set(before);
      if (
        !ok ||
        ids.length !== model.length ||
        model.some((id, i) => (id === null ? old.has(ids[i]) : id !== ids[i]))
      ) {
        fails.push(
          `seed ${seed}: ${JSON.stringify(nodes)} ${how} ${JSON.stringify(edits)} ${after} -> ${JSON.stringify(lineText(t.a))}`,
        );
      }
      t.peers.forEach(p => p.stop());
    }
    expect(fails).toEqual([]);
  }, 600_000);
});
