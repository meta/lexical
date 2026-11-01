/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Node swaps in one update, as transforms and app code make them, around
// caret edits (typing, Backspace, Delete) in the same update: a part split
// off and made again as another node (a custom text class, or plain text),
// a whole node made again as another, two equal neighbours made plain text
// at once, one node grown over the next by text moved out of it (both set
// whole, the next removed when emptied) or shrunk into it, and a range
// wrapped in an inline element (a link) or unwrapped. None of these changes
// the line's text: they change which node holds a character, which flat
// storage keeps as attributes of its characters. So each character's
// provenance is the caret edits' alone: every character they kept keeps its
// Yjs item, the ones they deleted are gone, and the typed ones are new,
// whichever node holds them. A peer's concurrent delete of a kept character
// stays deleted, its typing stays where it typed it, and every peer and a
// fresh reader converge.

import {$createLinkNode, $isLinkNode} from '@lexical/link';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setSelection,
  type ElementNode,
  type LexicalNode,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {freshReader, NODES, type Peer, setup} from '../utils/harness';

/** A custom text class, as an app's entity or highlight. */
class TagNode extends TextNode {
  $config() {
    return this.config('test-tag', {extends: TextNode});
  }
}

const $createTagNode = (text: string): TagNode =>
  $create(TagNode).setTextContent(text);
const $isTagNode = (node: LexicalNode | null | undefined): node is TagNode =>
  node instanceof TagNode;

const ALL = [...NODES, TagNode];

const $line = () => $getRoot().getChildAtIndex(1) as ElementNode;

/** The ids and characters of line `n`'s text. */
function lineAtoms(p: Peer, n: number): {ids: string[]; text: string} {
  const lines: {ids: string[]; text: string}[] = [{ids: [], text: ''}];
  const root = p.binding.root as unknown as {_start: Y.Item | null};
  for (let it = root._start; it !== null; it = it.right) {
    if (it.deleted || !it.countable) {
      continue;
    }
    const line = lines[lines.length - 1];
    if (it.content instanceof Y.ContentString) {
      for (let k = 0; k < it.length; k++) {
        line.ids.push(`${it.id.client}:${it.id.clock + k}`);
      }
      line.text += it.content.str;
    } else if (it.content instanceof Y.ContentType) {
      lines.push({ids: [], text: ''});
    }
  }
  return lines[n];
}

/** The text a peer's own transactions delete and insert. */
function writes(doc: Y.Doc): {del: string; ins: string} {
  const w = {del: '', ins: ''};
  doc.on('afterTransaction', (tr: Y.Transaction) => {
    if (!tr.local) {
      return;
    }
    Y.iterateStructsByIdSet(tr, tr.insertSet, s => {
      if (s instanceof Y.Item && s.content instanceof Y.ContentString) {
        w.ins += s.content.str;
      }
    });
    Y.iterateStructsByIdSet(tr, tr.deleteSet, s => {
      if (s instanceof Y.Item && s.content instanceof Y.ContentString) {
        w.del += s.content.str;
      }
    });
  });
  return w;
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

const PIECES = ['ab', 'aa', 'la ', ' ', 'abab', 'x😀y', '😀', 'b', 'a a'];
const TYPED = ['a', 'b', ' ', 'x', '😀', 'aa'];

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** The line's text nodes in order (through links), with where each starts. */
function $texts(): [TextNode, number][] {
  const out: [TextNode, number][] = [];
  let pos = 0;
  const walk = (el: ElementNode) => {
    for (const c of el.getChildren()) {
      if ($isTextNode(c)) {
        out.push([c, pos]);
        pos += c.getTextContentSize();
      } else if ($isElementNode(c)) {
        walk(c);
      } else {
        pos += c.getTextContentSize();
      }
    }
  };
  walk($line());
  return out;
}

const $text = () => $line().getTextContent();

/** The text point at line offset `at` (the earlier node, or the later). */
function $pointAt(at: number, later: boolean): [TextNode, number] | null {
  let found: [TextNode, number] | null = null;
  for (const [node, start] of $texts()) {
    const n = node.getTextContentSize();
    if (at >= start && at <= start + n) {
      found = [node, at - start];
      if (!later || at < start + n) {
        return found;
      }
    }
  }
  return found;
}

/** A cut of `text` near `at` that splits no surrogate pair. */
const whole = (text: string, at: number) =>
  at > 0 && at < text.length && isHigh(text.charCodeAt(at - 1)) ? at + 1 : at;

type Edit =
  | {kind: 'type'; at: number; text: string}
  | {kind: 'delete'; from: number; to: number};

/** A caret edit: typing, Backspace or Delete, somewhere in the line. */
function $caretEdit(r: () => number): Edit | null {
  const text = $text();
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)];
  const at = whole(text, Math.floor(r() * (text.length + 1)));
  const kind = pick(['type', 'type', 'backspace', 'delete'] as const);
  const sel = $createRangeSelection();
  if (kind === 'type') {
    const p = $pointAt(at, r() < 0.5);
    if (p === null) {
      return null;
    }
    const s = pick(TYPED);
    sel.anchor.set(p[0].getKey(), p[1], 'text');
    sel.focus.set(p[0].getKey(), p[1], 'text');
    $setSelection(sel);
    sel.insertText(s);
    return {at, kind: 'type', text: s};
  }
  let from = kind === 'backspace' ? at - 1 : at;
  let to = kind === 'backspace' ? at : at + 1;
  if (from < 0 || to > text.length) {
    return null;
  }
  if (isLow(text.charCodeAt(from))) {
    from--;
  }
  if (isHigh(text.charCodeAt(to - 1))) {
    to++;
  }
  const a = $pointAt(from, true);
  const b = $pointAt(to, false);
  if (a === null || b === null) {
    return null;
  }
  sel.anchor.set(a[0].getKey(), a[1], 'text');
  sel.focus.set(b[0].getKey(), b[1], 'text');
  $setSelection(sel);
  sel.removeText();
  return {from, kind: 'delete', to};
}

/** A node made with `text` in place of `node`: the other class, maybe bold. */
function $remake(node: TextNode, text: string, r: () => number): TextNode {
  const made = $isTagNode(node) ? $createTextNode(text) : $createTagNode(text);
  made.setFormat(node.getFormat());
  if (r() < 0.3) {
    made.toggleFormat('bold');
  }
  return made;
}

const SWAPS = [
  'splitReplace',
  'replaceWhole',
  'plainAtOnce',
  'grow',
  'shrink',
  'wrap',
  'unwrap',
] as const;

/** A node swap that keeps the line's text; its name, or null. */
function $swap(r: () => number): string | null {
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)];
  const texts = $texts()
    .map(([n]) => n)
    .filter(n => n.getTextContentSize() > 0);
  if (texts.length === 0) {
    return null;
  }
  const kind = pick(SWAPS);
  switch (kind) {
    case 'splitReplace': {
      const node = pick(texts);
      const t = node.getTextContent();
      if (t.length < 2) {
        return null;
      }
      const a = whole(t, Math.floor(r() * t.length));
      const b = whole(t, a + 1 + Math.floor(r() * (t.length - a)));
      if (b <= a || (a === 0 && b >= t.length)) {
        return null;
      }
      const cuts = [a, b].filter(x => x > 0 && x < t.length);
      const part = node.splitText(...cuts)[a > 0 && a < t.length ? 1 : 0];
      if (part === undefined) {
        return null;
      }
      part.replace($remake(part, part.getTextContent(), r));
      return `${kind} [${a},${b}) of ${JSON.stringify(t)}`;
    }
    case 'replaceWhole': {
      const node = pick(texts);
      node.replace($remake(node, node.getTextContent(), r));
      return `${kind} ${JSON.stringify(node.getTextContent())}`;
    }
    case 'plainAtOnce': {
      const tags = texts.filter(
        n =>
          $isTagNode(n) &&
          $isTagNode(n.getNextSibling()) &&
          n.getNextSibling()!.getTextContentSize() > 0,
      );
      if (tags.length === 0) {
        return null;
      }
      const first = pick(tags);
      const second = first.getNextSibling() as TagNode;
      for (const n of [first, second]) {
        n.replace(
          $createTextNode(n.getTextContent())
            .setFormat(n.getFormat())
            .setStyle(n.getStyle()),
        );
      }
      return `${kind} ${JSON.stringify(first.getTextContent())} ${JSON.stringify(second.getTextContent())}`;
    }
    case 'grow':
    case 'shrink': {
      const tags = texts.filter(
        n => $isTagNode(n) && $isTextNode(n.getNextSibling()),
      );
      if (tags.length === 0) {
        return null;
      }
      const tag = pick(tags);
      const next = tag.getNextSibling() as TextNode;
      const tt = tag.getTextContent();
      const nt = next.getTextContent();
      if (kind === 'grow') {
        if (nt.length === 0) {
          return null;
        }
        const k = whole(nt, 1 + Math.floor(r() * nt.length));
        tag.setTextContent(tt + nt.slice(0, k));
        if (k >= nt.length) {
          next.remove();
        } else {
          next.setTextContent(nt.slice(k));
        }
        return `grow ${JSON.stringify(tt)} by ${k} of ${JSON.stringify(nt)}`;
      }
      if (tt.length < 2) {
        return null;
      }
      const k = whole(tt, Math.floor(r() * (tt.length - 1)) + 1);
      if (k >= tt.length) {
        return null;
      }
      tag.setTextContent(tt.slice(0, k));
      next.setTextContent(tt.slice(k) + nt);
      return `shrink ${JSON.stringify(tt)} to ${k} into ${JSON.stringify(nt)}`;
    }
    case 'wrap': {
      const top = $line()
        .getChildren()
        .filter((c): c is TextNode => $isTextNode(c));
      if (top.length === 0) {
        return null;
      }
      const first = pick(top);
      const nodes: TextNode[] = [first];
      const second = first.getNextSibling();
      if ($isTextNode(second) && r() < 0.5) {
        nodes.push(second);
      }
      const link = $createLinkNode('https://x.y/' + Math.floor(r() * 3));
      first.insertBefore(link);
      link.append(...nodes);
      return `${kind} ${nodes.length}`;
    }
    case 'unwrap': {
      const links = $line().getChildren().filter($isLinkNode);
      if (links.length === 0) {
        return null;
      }
      const link = pick(links);
      for (const c of link.getChildren()) {
        link.insertBefore(c);
      }
      link.remove();
      return kind;
    }
  }
}

/** Apply `op` to a model of the line: its text and each character's id. */
function apply(model: {ids: (string | null)[]; text: string}, op: Edit): void {
  if (op.kind === 'type') {
    model.ids.splice(op.at, 0, ...new Array<null>(op.text.length).fill(null));
    model.text = model.text.slice(0, op.at) + op.text + model.text.slice(op.at);
  } else {
    model.ids.splice(op.from, op.to - op.from);
    model.text = model.text.slice(0, op.from) + model.text.slice(op.to);
  }
}

/** Whether the write kept exactly the characters the model keeps. */
function provenance(
  model: {ids: (string | null)[]; text: string},
  after: {ids: string[]; text: string},
  old: ReadonlySet<string>,
): string | null {
  if (after.text !== model.text) {
    return `stored ${JSON.stringify(after.text)}, expected ${JSON.stringify(model.text)}`;
  }
  // Kept for another character (wrong), or written anew (lost).
  const wrong: number[] = [];
  const lost: number[] = [];
  model.ids.forEach((id, i) => {
    if (id === null ? old.has(after.ids[i]) : after.ids[i] !== id) {
      (old.has(after.ids[i]) ? wrong : lost).push(i);
    }
  });
  return wrong.length + lost.length > 0
    ? `kept wrongly at ${JSON.stringify(wrong)}, written anew at ${JSON.stringify(lost)}`
    : null;
}

describe('node swaps keep the characters where they are', () => {
  const n = Number(process.env.NODE_SWAP_SEEDS ?? 400);
  const only = process.env.NODE_SWAP_SEED;
  test(`${n} seeded updates of node swaps and caret edits, with a peer`, async () => {
    const fails: string[] = [];
    let ran = 0;
    const from = only !== undefined ? Number(only) : 1;
    const to = only !== undefined ? Number(only) : n;
    for (let seed = from; seed <= to; seed++) {
      const r = rng(seed * 7877);
      const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)];
      const pieces: [string, number][] = [];
      for (let i = 2 + Math.floor(r() * 4); i > 0; i--) {
        pieces.push([pick(PIECES), Math.floor(r() * 4)]);
      }
      const t = await setup(
        () => {
          const nodes: LexicalNode[] = pieces.map(([s, k]) => {
            const node = k === 1 ? $createTagNode(s) : $createTextNode(s);
            if (k === 2) {
              node.toggleFormat('bold');
            }
            return k === 3
              ? $createLinkNode('https://x.y/0').append(node)
              : node;
          });
          $getRoot().append(
            $createParagraphNode().append($createTextNode('Title')),
            $createParagraphNode().append(...nodes),
          );
        },
        {nodes: ALL},
      );
      const [a, b] = t.peers;
      const before = lineAtoms(a, 1);
      const old = new Set(before.ids);
      const model = {
        ids: before.ids.slice() as (string | null)[],
        text: before.text,
      };
      const steps: string[] = [];
      const wrote = writes(a.doc);
      const count = 2 + Math.floor(r() * 4);
      const keepCaret = r() < 0.5;
      t.offline();
      let threw: unknown = null;
      a.update(() => {
        try {
          for (let i = 0; i < count; i++) {
            if (r() < 0.35) {
              const op = $caretEdit(r);
              if (op !== null) {
                steps.push(JSON.stringify(op));
                apply(model, op);
              }
            } else {
              const done = $swap(r);
              if (done !== null) {
                steps.push(done);
              }
            }
          }
          if (!keepCaret) {
            $setSelection(null);
          }
        } catch (e) {
          threw = e;
        }
      });
      const desc = `seed ${seed}: ${JSON.stringify(pieces)} ${JSON.stringify(steps)}`;
      if (threw !== null || steps.length === 0) {
        t.peers.forEach(p => p.stop());
        if (threw !== null) {
          fails.push(`${desc}: threw ${String(threw)}`);
        }
        continue;
      }
      ran++;
      const shape = a.read(() =>
        $line()
          .getChildren()
          .map(c => `${c.getType()}:${JSON.stringify(c.getTextContent())}`)
          .join(' '),
      );
      const flat = a.read($text);
      const after = lineAtoms(a, 1);
      const wrong =
        flat !== model.text
          ? `editor ${JSON.stringify(flat)}, expected ${JSON.stringify(model.text)}`
          : provenance(model, after, old);
      if (wrong !== null) {
        fails.push(
          `${desc} -> ${shape} (wrote del ${JSON.stringify(wrote.del)} ins ${JSON.stringify(wrote.ins)}): ${wrong}`,
        );
        t.peers.forEach(p => p.stop());
        continue;
      }
      // The peer at the same time: deletes a character the author kept, or
      // types between two the author kept and wrote nothing between.
      const keptAt = (id: string) => model.ids.indexOf(id);
      let expected = model.text;
      let peerOp: Edit | null = null;
      if (r() < 0.6) {
        const candidates = before.ids
          .map((id, j) => [id, j] as const)
          .filter(
            ([id, j]) => keptAt(id) >= 0 && !isLow(before.text.charCodeAt(j)),
          );
        if (candidates.length > 0) {
          const [id, j] = pick(candidates);
          const k = isHigh(before.text.charCodeAt(j)) ? 2 : 1;
          peerOp = {from: j, kind: 'delete', to: j + k};
          const at = keptAt(id);
          expected = expected.slice(0, at) + expected.slice(at + k);
        }
      } else {
        const gaps: number[] = [];
        for (let j = 0; j <= before.ids.length; j++) {
          const left = j > 0 ? keptAt(before.ids[j - 1]) : -1;
          const right =
            j < before.ids.length ? keptAt(before.ids[j]) : model.ids.length;
          const inPair =
            j > 0 &&
            j < before.ids.length &&
            isHigh(before.text.charCodeAt(j - 1));
          if (
            !inPair &&
            (j === 0 || left >= 0) &&
            (j === before.ids.length || right >= 0) &&
            right === left + 1
          ) {
            gaps.push(j);
          }
        }
        if (gaps.length > 0) {
          const j = pick(gaps);
          peerOp = {at: j, kind: 'type', text: 'Z'};
          const at = j > 0 ? keptAt(before.ids[j - 1]) + 1 : 0;
          expected = expected.slice(0, at) + 'Z' + expected.slice(at);
        }
      }
      if (peerOp !== null) {
        const op = peerOp;
        b.update(() => {
          const sel = $createRangeSelection();
          if (op.kind === 'type') {
            const p = $pointAt(op.at, r() < 0.5)!;
            sel.anchor.set(p[0].getKey(), p[1], 'text');
            sel.focus.set(p[0].getKey(), p[1], 'text');
            $setSelection(sel);
            sel.insertText(op.text);
          } else {
            const pa = $pointAt(op.from, true)!;
            const pb = $pointAt(op.to, false)!;
            sel.anchor.set(pa[0].getKey(), pa[1], 'text');
            sel.focus.set(pb[0].getKey(), pb[1], 'text');
            $setSelection(sel);
            sel.removeText();
          }
          $setSelection(null);
        });
      }
      await t.sync();
      await t.sync();
      const fresh = await freshReader(a, ALL);
      const texts = [a, b, fresh].map(p => p.read($text));
      const stored = lineAtoms(a, 1).text;
      if (
        texts.some(x => x !== expected) ||
        stored !== expected ||
        lineAtoms(fresh, 1).text.includes('\ufffd')
      ) {
        fails.push(
          `${desc} -> ${shape}; peer ${JSON.stringify(peerOp)}: ${JSON.stringify(texts)} stored ${JSON.stringify(stored)}, expected ${JSON.stringify(expected)}`,
        );
      }
      [...t.peers, fresh].forEach(p => p.stop());
    }
    // eslint-disable-next-line no-console
    console.log(`node swap edits: ${ran} run, ${fails.length} wrong`);
    expect(fails).toEqual([]);
  }, 900_000);
});
