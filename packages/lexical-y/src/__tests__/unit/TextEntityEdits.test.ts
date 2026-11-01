/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Typing and backspacing next to text entities, with the text-entity
// transforms on (registerLexicalTextEntity: the hashtag plugin, and a
// keyword entity built on the same helper), on the author and, in half of
// the seeds, on the peer too, while the peer edits the same line at the same
// time. The transforms only move text between nodes: they make an entity of
// a part (splitText, replace), grow one with the text of its next sibling
// (setTextContent of both, or the sibling removed), and make one plain text
// again. So the line's text is the text the edit left, and each character's
// provenance is known: every character the edit kept keeps its Yjs item, the
// one it deleted is gone, and the one it typed is new. A peer's concurrent
// delete of a kept character stays deleted, its typing stays where it typed
// it, and no character's payload changes (no U+FFFD, as when a surrogate
// pair is split). R18A-1 (a Backspace next to a stored hashtag rewrote the
// text the hashtag grew by, so a peer's concurrent delete there came back)
// and R18A-4 (an emoji kept between two edits was split) were of this kind.

import {
  $createHashtagNode,
  HashtagNode,
  registerLexicalHashtag,
} from '@lexical/hashtag';
import {registerLexicalTextEntity} from '@lexical/text';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isTextNode,
  $setSelection,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {freshReader, NODES, type Peer, setup} from '../utils/harness';

/** A keyword entity, as the playground's keywords plugin makes them. */
class KeywordNode extends TextNode {
  $config() {
    return this.config('test-keyword', {extends: TextNode});
  }
  isTextEntity(): true {
    return true;
  }
  canInsertTextBefore(): boolean {
    return false;
  }
  canInsertTextAfter(): boolean {
    return false;
  }
}

const $createKeywordNode = (text: string): KeywordNode =>
  $create(KeywordNode).setTextContent(text);

const KEYWORD = /(^|[^a-z#])(cat|dog)(?=[^a-z]|$)/;

function registerKeywords(editor: LexicalEditor): () => void {
  const off = registerLexicalTextEntity(
    editor,
    text => {
      const m = KEYWORD.exec(text);
      return m === null
        ? null
        : {
            end: m.index + m[1].length + m[2].length,
            start: m.index + m[1].length,
          };
    },
    KeywordNode,
    node => $createKeywordNode(node.getTextContent()),
  );
  return () => off.forEach(f => f());
}

function plugins(editor: LexicalEditor): void {
  registerLexicalHashtag(editor);
  registerKeywords(editor);
}

const ALL = [...NODES, HashtagNode, KeywordNode];

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

// Pieces of the line: entities stored as entity nodes, and text next to
// them (shared letters, spaces, an emoji).
const PIECES = [
  '#fo',
  '#ab',
  'cat',
  'dog',
  'say ',
  ' lala',
  'la',
  ' ',
  'x😀y',
  '😀',
  'aa',
  ' #q',
  'o',
];
const TYPED = ['o', 'a', 'l', ' ', '#', 'x', 'c', 't', 'g', '😀'];

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** The line's text, from the editor. */
const $text = () => $line().getTextContent();

/** The text node and offset at line offset `at` (the earlier one, or not). */
function $pointAt(at: number, later: boolean): [TextNode, number] | null {
  let pos = 0;
  let found: [TextNode, number] | null = null;
  for (const c of $line().getChildren()) {
    const n = c.getTextContentSize();
    if ($isTextNode(c) && at >= pos && at <= pos + n) {
      found = [c, at - pos];
      if (!later || at < pos + n) {
        return found;
      }
    }
    pos += n;
  }
  return found;
}

/** Line offsets next to an entity or a node boundary. */
function $boundaries(): number[] {
  const out: number[] = [];
  let pos = 0;
  for (const c of $line().getChildren()) {
    out.push(pos);
    pos += c.getTextContentSize();
  }
  out.push(pos);
  return out;
}

type Op =
  | {kind: 'type'; at: number; text: string}
  | {kind: 'delete'; from: number; to: number};

/** One random caret edit near an entity, made in the update. */
function $edit(r: () => number): Op | null {
  const text = $text();
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)];
  const near = pick($boundaries()) + pick([-1, 0, 0, 1]);
  let at = r() < 0.75 ? near : Math.floor(r() * (text.length + 1));
  at = Math.max(0, Math.min(text.length, at));
  // Never inside a pair.
  if (at > 0 && at < text.length && isHigh(text.charCodeAt(at - 1))) {
    at++;
  }
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
  // Backspace deletes the character before the caret, Delete the one after.
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

/** Apply `op` to a model of the line: its text and each character's id. */
function apply(model: {ids: (string | null)[]; text: string}, op: Op): void {
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
  const wrong: number[] = [];
  model.ids.forEach((id, i) => {
    if (id === null ? old.has(after.ids[i]) : after.ids[i] !== id) {
      wrong.push(i);
    }
  });
  return wrong.length > 0 ? `kept wrongly at ${JSON.stringify(wrong)}` : null;
}

describe('typing and backspacing next to text entities', () => {
  const n = Number(process.env.TEXT_ENTITY_SEEDS ?? 300);
  const only = process.env.TEXT_ENTITY_SEED;
  test(`${n} seeded edits next to hashtags and keywords, with a peer`, async () => {
    const fails: string[] = [];
    let ran = 0;
    const from = only !== undefined ? Number(only) : 1;
    const to = only !== undefined ? Number(only) : n;
    for (let seed = from; seed <= to; seed++) {
      const r = rng(seed * 104729);
      const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)];
      const pieces: string[] = [];
      for (let i = 2 + Math.floor(r() * 4); i > 0; i--) {
        pieces.push(pick(PIECES));
      }
      const bold = pieces.map(() => r() < 0.2);
      const peerPlugins = r() < 0.5;
      const t = await setup(
        () => {
          const nodes: LexicalNode[] = pieces.map((s, i) => {
            const node =
              s.startsWith('#') && r() < 0.8
                ? $createHashtagNode(s)
                : (s === 'cat' || s === 'dog') && r() < 0.8
                  ? $createKeywordNode(s)
                  : $createTextNode(s);
            if (bold[i]) {
              node.toggleFormat('bold');
            }
            return node;
          });
          $getRoot().append(
            $createParagraphNode().append($createTextNode('Title')),
            $createParagraphNode().append(...nodes),
          );
        },
        {nodes: ALL},
      );
      const [a, b] = t.peers;
      plugins(a.editor);
      if (peerPlugins) {
        plugins(b.editor);
      }
      const before = lineAtoms(a, 1);
      const old = new Set(before.ids);
      const model = {
        ids: before.ids.slice() as (string | null)[],
        text: before.text,
      };
      const steps: Op[] = [];
      const wrote = writes(a.doc);
      const count = r() < 0.7 ? 1 : 2;
      const keepCaret = r() < 0.5;
      t.offline();
      let threw: unknown = null;
      a.update(() => {
        try {
          for (let i = 0; i < count; i++) {
            const op = $edit(r);
            if (op !== null) {
              steps.push(op);
              apply(model, op);
            }
          }
          if (!keepCaret) {
            $setSelection(null);
          }
        } catch (e) {
          threw = e;
        }
      });
      const desc = `seed ${seed} (peer plugins ${peerPlugins}): ${JSON.stringify(pieces)} bold ${JSON.stringify(bold)} ${JSON.stringify(steps)}`;
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
      const peerModel = {
        ids: before.ids.slice() as (string | null)[],
        text: before.text,
      };
      let peerOp: Op | null = null;
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
        apply(peerModel, op);
        const peerWrong = provenance(peerModel, lineAtoms(b, 1), old);
        if (peerWrong !== null) {
          fails.push(
            `${desc} -> ${shape}; peer ${JSON.stringify(op)}: peer's write ${peerWrong}`,
          );
          t.peers.forEach(p => p.stop());
          continue;
        }
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
    console.log(`text entity edits: ${ran} run, ${fails.length} wrong`);
    expect(fails).toEqual([]);
  }, 600_000);
});
