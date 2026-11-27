/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Compound edits in one update, as agents and app code make them: two to
// four of splice, setTextContent, a node made before or after (text of the
// same or another format, a line break, an inline node), a node removed, a
// range formatted, a split, a range extracted and removed, a range deleted
// or typed over, and the caret set or cleared, on one or two adjacent text
// nodes, with line breaks and inline nodes between and next to them (equal
// ones side by side too). Each character's provenance is modelled: what the
// update writes must keep every character it kept, by its Yjs item, delete
// the ones it deleted and insert the new ones where they are; and a peer's
// concurrent delete of a kept character stays deleted. Soak S5-2 (a node
// made next to an edited one, merged into it, was written as a rewrite of
// the node), S5-3 (two edits on either side of a line break or an inline
// node were written as one rewrite of everything between them) and S5-4 (a
// line break typed before another was written after it) were of this kind.
// What the record does not place exactly is placed by where it is in the
// line (see TextReplay in TextEdits.ts): text set whole (setTextContent) and
// the text or line break of a made node may keep characters of text that
// left the line otherwise than by a delete (a text set whole, a node removed
// or extracted and removed), as a text-entity transform moves text between
// nodes; any other old character it keeps is wrong, and so is a typed
// character that keeps one.

import * as Y from '@y/y';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type ElementNode,
  type LexicalNode,
  type TextFormatType,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {$createEquation, type Peer, setup} from '../utils/harness';

const OBJ = '\ufffc';
const MARKER = '\u00b6';

/** The ids and characters of line `n`'s atoms (text, breaks, nodes). */
function lineAtoms(p: Peer, n: number): {ids: string[]; text: string} {
  const lines: {ids: string[]; text: string}[] = [{ids: [], text: ''}];
  const root = p.binding.root as unknown as {_start: Y.Item | null};
  for (let it = root._start; it !== null; it = it.right) {
    if (it.deleted || !it.countable) {
      continue;
    }
    const line = lines[lines.length - 1];
    if (it.content instanceof Y.ContentString) {
      const s = it.content.str;
      for (let k = 0; k < it.length; k++) {
        line.ids.push(`${it.id.client}:${it.id.clock + k}`);
      }
      line.text += s;
    } else if (it.content instanceof Y.ContentType) {
      const name = (it.content.type as unknown as {name: string}).name;
      if (name === MARKER) {
        lines.push({ids: [], text: ''});
      } else {
        line.ids.push(`${it.id.client}:${it.id.clock}`);
        line.text += OBJ;
      }
    }
  }
  return lines[n];
}

const $line = () => $getRoot().getChildAtIndex(1) as ElementNode;

const size = (n: LexicalNode) => ($isTextNode(n) ? n.getTextContentSize() : 1);

/** The line's atoms as text: a line break `\n`, an inline node OBJ. */
function $flat(): string {
  return $line()
    .getChildren()
    .map(n =>
      $isTextNode(n) ? n.getTextContent() : $isLineBreakNode(n) ? '\n' : OBJ,
    )
    .join('');
}

function $start(node: LexicalNode): number {
  let pos = 0;
  for (
    let c = node.getPreviousSibling();
    c !== null;
    c = c.getPreviousSibling()
  ) {
    pos += size(c);
  }
  return pos;
}

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

const WORDS = [
  'la ',
  'la la ',
  'ab',
  'aa',
  'a ',
  't3z ',
  'abc',
  'def',
  ' ',
  'X',
];
const FORMATS: (TextFormatType | null)[] = [null, 'bold', 'italic'];
type Mid = 'none' | 'break' | 'node' | 'breaks' | 'nodes';
const MIDS: Mid[] = ['none', 'none', 'break', 'node', 'breaks', 'nodes'];

const $mid = (m: Mid): LexicalNode[] =>
  m === 'break'
    ? [$createLineBreakNode()]
    : m === 'node'
      ? [$createEquation('e')]
      : m === 'breaks'
        ? [$createLineBreakNode(), $createLineBreakNode()]
        : m === 'nodes'
          ? [$createEquation('e'), $createEquation('e')]
          : [];

/** One seed's line: its children, by kind, text and format. */
type Shape = {
  texts: [string, TextFormatType | null][];
  between: Mid;
  edge: Mid;
  edgeFirst: boolean;
};

function shapeOf(r: () => number): Shape {
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)];
  const k = r() < 0.5 ? 1 : 2;
  const texts: [string, TextFormatType | null][] = [];
  for (let i = 0; i < k; i++) {
    texts.push([
      pick(WORDS) + (r() < 0.6 ? pick(WORDS) : ''),
      i === 0 ? pick(FORMATS) : pick(FORMATS),
    ]);
  }
  return {
    between: k === 2 ? pick(MIDS) : 'none',
    edge: pick(MIDS),
    edgeFirst: r() < 0.5,
    texts,
  };
}

function $build(shape: Shape): LexicalNode[] {
  const out: LexicalNode[] = [];
  shape.texts.forEach(([s, f], i) => {
    if (i === 1) {
      out.push(...$mid(shape.between));
    }
    const t = $createTextNode(s);
    if (f !== null) {
      t.toggleFormat(f);
    }
    out.push(t);
  });
  return shape.edgeFirst
    ? [...$mid(shape.edge), ...out]
    : [...out, ...$mid(shape.edge)];
}

/**
 * The line's atoms as the update leaves them: an old atom's id, null for a
 * new one, or for text set whole or made, the old ids of the text that left
 * the line otherwise than by a delete (the write may keep any of those, see
 * the header).
 */
type Cell = string | null | {readonly set: ReadonlySet<string>};
type Model = {
  ids: Cell[];
  text: string;
  setText: boolean;
  /** Old ids of text that left the line otherwise than by a delete. */
  left: {readonly set: Set<string>};
};

const OPS = [
  'splice',
  'type',
  'typeOver',
  'setTextContent',
  'make',
  'remove',
  'format',
  'split',
  'extract',
  'deleteRange',
  'caret',
] as const;
type Op = (typeof OPS)[number];

/**
 * Apply one random operation of kind `op` inside the update, and the same
 * change to the model of the line's atoms (`ids`: an old atom's id, or null
 * for a new one). Returns a description, or null when it does not apply.
 */
function $apply(op: Op, r: () => number, model: Model): string | null {
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)];
  const line = $line();
  const texts = line.getChildren().filter($isTextNode);
  const children = line.getChildren();
  const splice = (at: number, del: number, ins: string, cell: Cell = null) => {
    model.ids.splice(at, del, ...new Array<Cell>(ins.length).fill(cell));
    model.text = model.text.slice(0, at) + ins + model.text.slice(at + del);
  };
  const text = (t: TextNode) => t.getTextContent();
  const noteLeft = (at: number, k: number) => {
    for (const c of model.ids.slice(at, at + k)) {
      if (typeof c === 'string') {
        model.left.set.add(c);
      }
    }
  };
  const noteRemoved = (n: LexicalNode, at: number, k: number) => {
    if ($isTextNode(n) || $isLineBreakNode(n)) {
      noteLeft(at, k);
    }
  };
  const word = (t: TextNode | null) =>
    t !== null && r() < 0.4
      ? text(t).slice(0, 1 + Math.floor(r() * text(t).length)) || 'q'
      : pick(WORDS);
  /** A text point at or after the line's atom `at`, or null. */
  const pointAt = (at: number): [TextNode, number] | null => {
    let pos = 0;
    for (const c of children) {
      const n = size(c);
      if ($isTextNode(c) && at <= pos + n && at >= pos) {
        return [c, at - pos];
      }
      pos += n;
    }
    return null;
  };
  const range = (): [[TextNode, number], [TextNode, number]] | null => {
    const total = model.text.length;
    if (total < 1) {
      return null;
    }
    const a = Math.floor(r() * total);
    const b = Math.min(total, a + 1 + Math.floor(r() * 5));
    const pa = pointAt(a);
    const pb = pointAt(b);
    return pa === null || pb === null ? null : [pa, pb];
  };
  switch (op) {
    case 'splice':
    case 'type': {
      if (texts.length === 0) {
        return null;
      }
      const t = pick(texts);
      const o = Math.floor(r() * (text(t).length + 1));
      const room = text(t).length - o;
      const del =
        op === 'type' || room === 0 || r() < 0.5
          ? 0
          : 1 + Math.floor(r() * Math.min(3, room));
      const ins = r() < 0.2 && del > 0 ? '' : word(t);
      const at = $start(t) + o;
      if (op === 'type') {
        t.select(o, o).insertText(ins);
      } else {
        t.spliceText(o, del, ins, false);
      }
      splice(at, del, ins);
      return `${op} ${JSON.stringify(ins)} @${at}${del > 0 ? ` del ${del}` : ''}`;
    }
    case 'typeOver': {
      const rg = range();
      if (rg === null) {
        return null;
      }
      const [[a, ao], [b, bo]] = rg;
      const from = $start(a) + ao;
      const to = $start(b) + bo;
      const ins = word(a);
      const s = $createRangeSelection();
      s.anchor.set(a.getKey(), ao, 'text');
      s.focus.set(b.getKey(), bo, 'text');
      $setSelection(s);
      s.insertText(ins);
      splice(from, to - from, ins);
      return `type over [${from},${to}) ${JSON.stringify(ins)}`;
    }
    case 'setTextContent': {
      if (texts.length === 0) {
        return null;
      }
      const t = pick(texts);
      const old = text(t);
      const o = Math.floor(r() * (old.length + 1));
      const next = pick([
        old.slice(0, o) + 'Q' + old.slice(o),
        old.slice(0, o) + old.slice(o + 1),
        pick(WORDS),
        old + old,
      ]);
      if (next === '' || next === old) {
        return null;
      }
      const at = $start(t);
      noteLeft(at, old.length);
      t.setTextContent(next);
      splice(at, old.length, next, model.left);
      model.setText = true;
      return `setTextContent ${JSON.stringify(old)} -> ${JSON.stringify(next)} @${at}`;
    }
    case 'make': {
      if (children.length === 0) {
        return null;
      }
      const anchor = pick(children);
      const before = r() < 0.5;
      const kind = pick(['same', 'same', 'other', 'break', 'node'] as const);
      let made: LexicalNode;
      let s: string;
      if (kind === 'break') {
        made = $createLineBreakNode();
        s = '\n';
      } else if (kind === 'node') {
        made = $createEquation('e');
        s = OBJ;
      } else {
        s = word($isTextNode(anchor) ? anchor : null);
        const t = $createTextNode(s);
        if ($isTextNode(anchor)) {
          t.setFormat(anchor.getFormat());
        }
        if (kind === 'other') {
          t.toggleFormat('underline');
        }
        made = t;
      }
      const at = $start(anchor) + (before ? 0 : size(anchor));
      if (before) {
        anchor.insertBefore(made);
      } else {
        anchor.insertAfter(made);
      }
      if ($isTextNode(made) || $isLineBreakNode(made)) {
        // Placed by where it is (see the header).
        splice(at, 0, s, model.left);
      } else {
        splice(at, 0, s);
      }
      return `make ${kind} ${JSON.stringify(s)} ${before ? 'before' : 'after'} @${at}`;
    }
    case 'remove': {
      if (children.length === 0) {
        return null;
      }
      const c = pick(children);
      const at = $start(c);
      const n = size(c);
      noteRemoved(c, at, n);
      c.remove();
      splice(at, n, '');
      return `remove [${at},${at + n})`;
    }
    case 'format': {
      const rg = range();
      if (rg === null) {
        return null;
      }
      const [[a, ao], [b, bo]] = rg;
      if (a.is(b) && ao === bo) {
        return null;
      }
      const s = $createRangeSelection();
      s.anchor.set(a.getKey(), ao, 'text');
      s.focus.set(b.getKey(), bo, 'text');
      $setSelection(s);
      const f = pick(['bold', 'italic', 'underline'] as TextFormatType[]);
      s.formatText(f);
      return `format ${f} [${$start(a) + ao}..]`;
    }
    case 'split': {
      const long = texts.filter(t => text(t).length > 1);
      if (long.length === 0) {
        return null;
      }
      const t = pick(long);
      const o = 1 + Math.floor(r() * (text(t).length - 1));
      t.splitText(o);
      return `split @${$start(t) + o}`;
    }
    case 'extract':
    case 'deleteRange': {
      const rg = range();
      if (rg === null) {
        return null;
      }
      const [[a, ao], [b, bo]] = rg;
      const from = $start(a) + ao;
      const to = $start(b) + bo;
      if (to <= from) {
        return null;
      }
      const s = $createRangeSelection();
      s.anchor.set(a.getKey(), ao, 'text');
      s.focus.set(b.getKey(), bo, 'text');
      $setSelection(s);
      if (op === 'deleteRange') {
        s.removeText();
        splice(from, to - from, '');
        return `delete [${from},${to})`;
      }
      const nodes = s.extract();
      let removed = '';
      for (const n of nodes) {
        if (n.getParent() !== null && n.getParent()!.is(line)) {
          const at = $start(n);
          const k = size(n);
          noteRemoved(n, at, k);
          n.remove();
          splice(at, k, '');
          removed += `[${at},${at + k})`;
        }
      }
      $setSelection(null);
      return `extract ${removed}`;
    }
    case 'caret': {
      if (r() < 0.5 || texts.length === 0) {
        $setSelection(null);
        return 'caret cleared';
      }
      const t = pick(texts);
      const o = Math.floor(r() * (text(t).length + 1));
      t.select(o, o);
      return `caret @${$start(t) + o}`;
    }
  }
}

describe('compound edits in one update keep each character it kept', () => {
  const n = Number(process.env.COMPOUND_EDIT_SEEDS ?? 600);
  const only = process.env.COMPOUND_EDIT_SEED;
  test(`${n} seeded compound edits`, async () => {
    const fails: string[] = [];
    let skipped = 0;
    const from = only !== undefined ? Number(only) : 1;
    const to = only !== undefined ? Number(only) : n;
    for (let seed = from; seed <= to; seed++) {
      const r = rng(seed * 7919);
      const shape = shapeOf(r);
      const t = await setup(() => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('Title')),
          $createParagraphNode().append(...$build(shape)),
        );
      });
      const before = lineAtoms(t.a, 1);
      const model: Model = {
        ids: before.ids.slice(),
        left: {set: new Set()},
        setText: false,
        text: before.text,
      };
      const steps: string[] = [];
      const count = 2 + Math.floor(r() * 3);
      t.offline();
      let threw: unknown = null;
      t.a.update(() => {
        $setSelection(null);
        try {
          for (let i = 0; i < count; i++) {
            const op = OPS[Math.floor(r() * OPS.length)];
            const done = $apply(op, r, model);
            if (done !== null) {
              steps.push(done);
            }
          }
          // A collapsed caret or none at the end, as an agent leaves it.
          const sel = $getSelection();
          if ($isRangeSelection(sel) && !sel.isCollapsed()) {
            $setSelection(null);
          }
        } catch (e) {
          threw = e;
        }
      });
      const desc = `seed ${seed}: ${JSON.stringify(shape)} ${JSON.stringify(steps)}`;
      if (threw !== null || steps.length < 2) {
        // An operation Lexical refused (not this test's subject).
        skipped++;
        t.peers.forEach(p => p.stop());
        continue;
      }
      const flat = t.a.read(() => $flat());
      const after = lineAtoms(t.a, 1);
      if (flat !== model.text || after.text !== model.text) {
        fails.push(
          `${desc}: model ${JSON.stringify(model.text)}, editor ${JSON.stringify(flat)}, stored ${JSON.stringify(after.text)}`,
        );
        t.peers.forEach(p => p.stop());
        continue;
      }
      const old = new Set(before.ids);
      const wrong: number[] = [];
      model.ids.forEach((c, i) => {
        const id = after.ids[i];
        if (
          c === null
            ? old.has(id)
            : typeof c === 'string'
              ? c !== id
              : old.has(id) && !c.set.has(id)
        ) {
          wrong.push(i);
        }
      });
      if (wrong.length > 0) {
        fails.push(
          `${desc}: ${JSON.stringify(model.text)} kept wrongly at ${JSON.stringify(wrong)}`,
        );
        t.peers.forEach(p => p.stop());
        continue;
      }
      // A peer deletes one old character at the same time: it stays deleted.
      const kept = before.ids
        .map((id, j) => [id, j] as const)
        .filter(
          ([id, j]) =>
            before.text[j] !== OBJ &&
            before.text[j] !== '\n' &&
            model.ids.includes(id),
        );
      if (kept.length > 0) {
        const [id, j] = kept[Math.floor(r() * kept.length)];
        t.b.update(() => {
          let pos = 0;
          for (const c of $line().getChildren()) {
            const k = size(c);
            if ($isTextNode(c) && j >= pos && j < pos + k) {
              c.spliceText(j - pos, 1, '', false);
              break;
            }
            pos += k;
          }
          $setSelection(null);
        });
        await t.sync();
        const at = after.ids.indexOf(id);
        const expected = model.text.slice(0, at) + model.text.slice(at + 1);
        const a = lineAtoms(t.a, 1).text;
        const b = lineAtoms(t.b, 1).text;
        if (a !== expected || b !== expected) {
          fails.push(
            `${desc}: peer deleted ${JSON.stringify(before.text[j])}@${j}: ${JSON.stringify(a)} / ${JSON.stringify(b)}, expected ${JSON.stringify(expected)}`,
          );
        }
      }
      t.peers.forEach(p => p.stop());
    }
    // eslint-disable-next-line no-console
    console.log(
      `compound edits: ${to - from + 1 - skipped} run, ${skipped} skipped, ${fails.length} wrong`,
    );
    expect(fails).toEqual([]);
  }, 600_000);
});
