/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The corpus of the block merge (internal/BlockMerge.ts, D133): documents
// and pairs of concurrent edits, generated from a seed, with an oracle that
// owes nothing to a diff. A document here is a model in which every
// character has an identity (a uid), and an edit names the characters it
// touches, so applying both sides' edits to the base is exact: the merge is
// right where it returns that document, and a conflict where the two
// orders of applying them disagree.
//
// The model's rules, which are an editor's:
// - text typed takes the format of the character before it (after it at
//   the start of a block), and is in a link only between two characters of
//   that link;
// - a format or a new link over a range covers what is typed inside it
//   (between two characters it changed), and a link's URL belongs to the
//   link, so text typed into it has it;
// - an edit that names a character the other side removed fails;
// - text both sides took out of a block (one may have moved it to another
//   block) is out of that block once, and stays where it was moved to.

import type {NodeKinds} from '../../internal/BlockMerge';
import type {SerializedLexicalNode} from 'lexical';

import {canonical, describeBlocks} from '../../internal/BlockMerge';

type Json = SerializedLexicalNode;

export interface Cell {
  readonly uid: number;
  /** One character (an extended cluster), or a line feed for a line break. */
  readonly ch: string;
  format: number;
  /** The link it is in (an instance, see Doc.links), 0 for none. */
  link: number;
}

export interface TextBlock {
  kind: 'text';
  id: string;
  type: 'paragraph' | 'heading' | 'quote' | 'listitem';
  tag: string;
  cells: Cell[];
}

export interface ListBlock {
  kind: 'list';
  id: string;
  items: TextBlock[];
}

export interface TableBlock {
  kind: 'table';
  id: string;
  /** Each cell holds one paragraph. */
  rows: TextBlock[][];
}

export type Block = TextBlock | ListBlock | TableBlock;

export interface Doc {
  blocks: Block[];
  links: Record<number, string>;
  /** Uids below it are the base's. */
  readonly baseUids: number;
}

export type Op = {readonly id: number} & (
  | {
      op: 'insert';
      left: number | null;
      right: number | null;
      text: string[];
      uids: number[];
      /** Typed at the end of a link, inside it. */
      extend: boolean;
    }
  | {op: 'delete'; uids: number[]}
  | {
      op: 'replace';
      uids: number[];
      left: number | null;
      right: number | null;
      text: string[];
      newUids: number[];
    }
  | {op: 'format'; bit: number; value: boolean; flips: number[]}
  | {op: 'relink'; inst: number; url: string}
  | {op: 'unlink'; inst: number}
  | {op: 'link'; inst: number; url: string; flips: number[]}
  | {op: 'type'; block: string; type: TextBlock['type']; tag: string}
  | {op: 'split'; at: number; newId: string}
  | {op: 'join'; block: string; next: string}
  | {op: 'addItem'; list: string; after: string | null; item: TextBlock}
  | {op: 'removeItem'; item: string}
  | {op: 'addRow'; table: string; row: TextBlock[]}
);

// ---------------------------------------------------------------------------
// The model

export function cloneDoc(doc: Doc): Doc {
  const text = (block: TextBlock): TextBlock => ({
    ...block,
    cells: block.cells.map(cell => ({...cell})),
  });
  return {
    baseUids: doc.baseUids,
    blocks: doc.blocks.map(block =>
      block.kind === 'text'
        ? text(block)
        : block.kind === 'list'
          ? {...block, items: block.items.map(text)}
          : {...block, rows: block.rows.map(row => row.map(text))},
    ),
    links: {...doc.links},
  };
}

/** Every block that holds text, in document order. */
export function textBlocks(doc: Doc): TextBlock[] {
  return doc.blocks.flatMap(block =>
    block.kind === 'text'
      ? [block]
      : block.kind === 'list'
        ? block.items
        : block.rows.flat(),
  );
}

function locate(
  doc: Doc,
  uid: number | null,
): {block: TextBlock; index: number} | null {
  if (uid === null) {
    return null;
  }
  for (const block of textBlocks(doc)) {
    const index = block.cells.findIndex(cell => cell.uid === uid);
    if (index >= 0) {
      return {block, index};
    }
  }
  return null;
}

/** The list of text blocks `block` is in (the document's, or a list's items). */
function siblings(doc: Doc, block: TextBlock): Block[] | null {
  if (doc.blocks.includes(block)) {
    return doc.blocks;
  }
  for (const top of doc.blocks) {
    if (top.kind === 'list' && top.items.includes(block)) {
      return top.items;
    }
  }
  return null;
}

function typed(
  doc: Doc,
  left: number | null,
  right: number | null,
  text: string[],
  uids: number[],
  extend: boolean,
): boolean {
  const after = locate(doc, left);
  const before = after === null ? locate(doc, right) : null;
  const place =
    after !== null
      ? {block: after.block, index: after.index + 1}
      : before !== null
        ? {block: before.block, index: before.index}
        : null;
  if (place === null) {
    return false;
  }
  const {block, index} = place;
  const l = block.cells[index - 1];
  const r = block.cells[index];
  const source =
    l !== undefined && l.ch !== '\n'
      ? l
      : r !== undefined && r.ch !== '\n'
        ? r
        : undefined;
  const link =
    l !== undefined &&
    l.link !== 0 &&
    (extend || (r !== undefined && r.link === l.link))
      ? l.link
      : 0;
  block.cells.splice(
    index,
    0,
    ...text.map((ch, i) => ({
      ch,
      format: source === undefined || ch === '\n' ? 0 : source.format,
      link,
      uid: uids[i],
    })),
  );
  return true;
}

/**
 * The cells typed since the base that a change to `changed` covers: each
 * run of them whose neighbours (a line break counts as the block's edge)
 * are both changed.
 */
function covered(doc: Doc, changed: ReadonlySet<number>): Cell[] {
  const cells: Cell[] = [];
  for (const block of textBlocks(doc)) {
    for (let start = 0; start < block.cells.length; ) {
      if (block.cells[start].uid < doc.baseUids) {
        start++;
        continue;
      }
      let end = start;
      while (end < block.cells.length && block.cells[end].uid >= doc.baseUids) {
        end++;
      }
      const around = [block.cells[start - 1], block.cells[end]].filter(
        cell => cell !== undefined && cell.ch !== '\n',
      );
      if (around.length === 2 && around.every(cell => changed.has(cell.uid))) {
        for (let i = start; i < end; i++) {
          if (block.cells[i].ch !== '\n') {
            cells.push(block.cells[i]);
          }
        }
      }
      start = end;
    }
  }
  return cells;
}

/** Apply `op` to `doc` in place; false when it names what is gone. */
export function applyOp(doc: Doc, op: Op): boolean {
  switch (op.op) {
    case 'insert':
      return typed(doc, op.left, op.right, op.text, op.uids, op.extend);
    case 'delete':
    case 'replace': {
      const gone = new Set(op.uids);
      for (const block of textBlocks(doc)) {
        block.cells = block.cells.filter(cell => !gone.has(cell.uid));
      }
      return op.op === 'delete'
        ? true
        : typed(doc, op.left, op.right, op.text, op.newUids, false);
    }
    case 'format': {
      const flips = new Set(op.flips);
      const cells = textBlocks(doc)
        .flatMap(block => block.cells)
        .filter(cell => flips.has(cell.uid));
      for (const cell of [...cells, ...covered(doc, flips)]) {
        cell.format = op.value ? cell.format | op.bit : cell.format & ~op.bit;
      }
      return true;
    }
    case 'relink':
      doc.links[op.inst] = op.url;
      return true;
    case 'unlink':
      for (const block of textBlocks(doc)) {
        for (const cell of block.cells) {
          if (cell.link === op.inst) {
            cell.link = 0;
          }
        }
      }
      return true;
    case 'link': {
      const flips = new Set(op.flips);
      doc.links[op.inst] = op.url;
      const cells = textBlocks(doc)
        .flatMap(block => block.cells)
        .filter(cell => flips.has(cell.uid));
      for (const cell of [...cells, ...covered(doc, flips)]) {
        cell.link = op.inst;
      }
      return true;
    }
    case 'type': {
      const block = doc.blocks.find(b => b.id === op.block);
      if (block === undefined || block.kind !== 'text') {
        return false;
      }
      block.type = op.type;
      block.tag = op.tag;
      return true;
    }
    case 'split': {
      const at = locate(doc, op.at);
      const list = at === null ? null : siblings(doc, at.block);
      if (at === null || list === null) {
        return false;
      }
      const tail = at.block.cells.splice(at.index);
      list.splice(list.indexOf(at.block) + 1, 0, {
        ...at.block,
        cells: tail,
        id: op.newId,
      });
      return true;
    }
    case 'join': {
      const all = textBlocks(doc);
      const block = all.find(b => b.id === op.block);
      const next = all.find(b => b.id === op.next);
      const list = block === undefined ? null : siblings(doc, block);
      if (
        block === undefined ||
        next === undefined ||
        list === null ||
        list[list.indexOf(block) + 1] !== next
      ) {
        return false;
      }
      block.cells.push(...next.cells);
      list.splice(list.indexOf(next), 1);
      return true;
    }
    case 'addItem': {
      const list = doc.blocks.find(b => b.id === op.list);
      if (list === undefined || list.kind !== 'list') {
        return false;
      }
      const after = list.items.findIndex(item => item.id === op.after);
      list.items.splice(after < 0 ? list.items.length : after + 1, 0, {
        ...op.item,
        cells: op.item.cells.map(cell => ({...cell})),
      });
      return true;
    }
    case 'removeItem': {
      for (const list of doc.blocks) {
        if (list.kind === 'list') {
          list.items = list.items.filter(item => item.id !== op.item);
        }
      }
      return true;
    }
    case 'addRow': {
      const table = doc.blocks.find(b => b.id === op.table);
      if (table === undefined || table.kind !== 'table') {
        return false;
      }
      table.rows.push(
        op.row.map(cell => ({
          ...cell,
          cells: cell.cells.map(c => ({...c})),
        })),
      );
      return true;
    }
  }
}

/** The length of a longest common subsequence of two texts. */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      row[j] =
        a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * Whether `ops` apply to `base`, and remove no more of a block than its
 * text shows: a character removed and typed again beside itself (a space
 * replaced by a word, and ` word` typed before it) reads as that character
 * kept, which is another edit than the model made.
 */
export function readsOneWay(base: Doc, ops: readonly Op[]): boolean {
  const doc = applyAll(base, ops);
  if (doc === null) {
    return false;
  }
  const after = new Map(textBlocks(doc).map(block => [block.id, block]));
  for (const was of textBlocks(base)) {
    const is = after.get(was.id);
    if (is === undefined) {
      continue;
    }
    const kept = new Set(is.cells.map(cell => cell.uid));
    const survivors = was.cells.filter(cell => kept.has(cell.uid)).length;
    if (
      lcsLength(
        was.cells.map(cell => cell.ch),
        is.cells.map(cell => cell.ch),
      ) > survivors
    ) {
      return false;
    }
  }
  return true;
}

/** `base` with `ops` applied in order (an op twice is applied once), or null. */
export function applyAll(base: Doc, ops: readonly Op[]): Doc | null {
  const doc = cloneDoc(base);
  const done = new Set<number>();
  for (const op of ops) {
    if (!done.has(op.id)) {
      done.add(op.id);
      if (!applyOp(doc, op)) {
        return null;
      }
    }
  }
  return doc;
}

// ---------------------------------------------------------------------------
// The model as Lexical JSON

const element = (type: string, children: unknown[], rest: object = {}) => ({
  children,
  direction: null,
  format: '',
  indent: 0,
  type,
  version: 1,
  ...rest,
});

function inlineJSON(doc: Doc, cells: readonly Cell[]): unknown[] {
  const out: unknown[] = [];
  let into = out;
  let link = 0;
  let last: {text: string; format: number} | null = null;
  for (const cell of cells) {
    if (cell.link !== link) {
      link = cell.link;
      last = null;
      into = out;
      if (link !== 0) {
        into = [];
        out.push(
          element('link', into, {
            rel: 'noreferrer',
            target: null,
            title: null,
            url: doc.links[link],
          }),
        );
      }
    }
    if (cell.ch === '\n') {
      into.push({type: 'linebreak', version: 1});
      last = null;
    } else if (last !== null && last.format === cell.format) {
      last.text += cell.ch;
    } else {
      last = {
        detail: 0,
        format: cell.format,
        mode: 'normal',
        style: '',
        text: cell.ch,
        type: 'text',
        version: 1,
      } as {text: string; format: number};
      into.push(last);
    }
  }
  return out;
}

function textJSON(doc: Doc, block: TextBlock, index: number): unknown {
  const state = {$: {blockId: block.id}};
  const children = inlineJSON(doc, block.cells);
  switch (block.type) {
    case 'heading':
      return element('heading', children, {...state, tag: block.tag});
    case 'quote':
      return element('quote', children, state);
    case 'listitem':
      return element('listitem', children, {...state, value: index + 1});
    default:
      return element('paragraph', children, {
        ...state,
        textFormat: 0,
        textStyle: '',
      });
  }
}

/** The document's top-level blocks as Lexical JSON. */
export function docJSON(doc: Doc): Json[] {
  return doc.blocks.map((block, i) => {
    if (block.kind === 'text') {
      return textJSON(doc, block, i);
    }
    const state = {$: {blockId: block.id}};
    if (block.kind === 'list') {
      return element(
        'list',
        block.items.map((item, k) => textJSON(doc, item, k)),
        {...state, listType: 'bullet', start: 1, tag: 'ul'},
      );
    }
    return element(
      'table',
      block.rows.map(row =>
        element(
          'tablerow',
          row.map(cell =>
            element('tablecell', [textJSON(doc, cell, 0)], {
              backgroundColor: null,
              colSpan: 1,
              headerState: 0,
              rowSpan: 1,
            }),
          ),
        ),
      ),
      state,
    );
  }) as unknown as Json[];
}

/** What each node type of docJSON is (as the headless read finds them). */
export const CORPUS_KINDS: NodeKinds = new Map([
  ['heading', 'block-element'],
  ['linebreak', 'linebreak'],
  ['link', 'inline-element'],
  ['list', 'block-element'],
  ['listitem', 'block-element'],
  ['paragraph', 'block-element'],
  ['quote', 'block-element'],
  ['table', 'block-element'],
  ['tablecell', 'block-element'],
  ['tablerow', 'block-element'],
  ['text', 'text'],
]);

/**
 * What a block shows, whatever its JSON's node boundaries and derived
 * properties: its type, and each character with its format and link, and
 * the same of the blocks it holds.
 */
export function project(node: Json): unknown {
  const record = node as unknown as Record<string, unknown>;
  const cells: unknown[] = [];
  const blocks: unknown[] = [];
  const walk = (nodes: Json[], url: string | null) => {
    for (const child of nodes) {
      const c = child as unknown as Record<string, unknown>;
      if (c.type === 'text') {
        for (const ch of Array.from(c.text as string)) {
          cells.push([ch, c.format, url]);
        }
      } else if (c.type === 'linebreak') {
        cells.push(['\n', 0, url]);
      } else if (c.type === 'link') {
        walk(c.children as Json[], c.url as string);
      } else {
        blocks.push(project(child));
      }
    }
  };
  walk((record.children as Json[]) || [], null);
  const state = record.$ as {blockId?: string} | undefined;
  return {
    blocks,
    cells,
    id: state === undefined ? null : (state.blockId ?? null),
    tag: record.tag ?? null,
    type: record.type,
  };
}

// ---------------------------------------------------------------------------
// The generator

export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE_WORDS =
  'the quick brown fox jumps over a lazy dog while seven wizards quietly mix bold potions near green hills and still waters'.split(
    ' ',
  );
/** Words only the user types, and words only the other side types. */
const YOUR_WORDS = ['Kiwi', 'Mango', 'Papaya', 'Fig', 'Lychee', 'Y'];
const THEIR_WORDS = ['zinc', 'quartz', 'onyx', 'jade', 'opal', 't'];
/** Clusters that one character of a string is not: an accent, a flag, a family. */
const CLUSTERS = [
  'é',
  String.fromCodePoint(0x1f1e8, 0x1f1e6),
  String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467),
  String.fromCodePoint(0x1f44d, 0x1f3fd),
];

export const FAMILIES = [
  'plain',
  'rich',
  'heading',
  'quote',
  'list',
  'table',
  'repeats',
] as const;
export type Family = (typeof FAMILIES)[number];

export interface Case {
  readonly seed: number;
  readonly family: Family;
  readonly base: Doc;
  /** The id of the top-level block both sides edit. */
  readonly target: string;
  readonly yours: readonly Op[];
  readonly theirs: readonly Op[];
  /** The kinds of the edits, for the report (`insert+format`). */
  readonly label: string;
}

/** The case of `seed`: a base document and two concurrent sets of edits. */
export function makeCase(seed: number): Case {
  const rand = random(seed * 2654435761 + 12345);
  const family = FAMILIES[seed % FAMILIES.length];
  const int = (n: number) => Math.floor(rand() * n);
  const pick = <T>(list: readonly T[]): T => list[int(list.length)];
  let uid = 0;
  let link = 0;
  let opId = 0;
  const links: Record<number, string> = {};
  const cells = (text: string[], format = 0, inst = 0): Cell[] =>
    text.map(ch => ({ch, format, link: inst, uid: uid++}));
  const chars = (text: string) => Array.from(text);
  const sentence = (words: number, repeats: boolean): Cell[] => {
    const out: Cell[] = [];
    for (let i = 0; i < words; i++) {
      if (i > 0) {
        out.push(...cells([' ']));
      }
      const word = repeats
        ? pick(['aa', 'ab', 'aba', 'bb', 'a', 'abab', 'baa'])
        : pick(BASE_WORDS);
      out.push(...cells(chars(word)));
      if (!repeats && rand() < 0.04) {
        out.push(...cells([pick(CLUSTERS)]));
      }
    }
    return out;
  };
  /** A sentence with bold and italic runs, a link and a line break. */
  const rich = (): Cell[] => {
    const out = sentence(5 + int(6), false);
    const run = (apply: (cell: Cell) => void) => {
      const from = int(out.length - 4);
      const to = from + 2 + int(Math.min(10, out.length - from - 2));
      for (let i = from; i < to; i++) {
        apply(out[i]);
      }
    };
    run(cell => {
      cell.format |= 1;
    });
    run(cell => {
      cell.format |= 2;
    });
    const inst = ++link;
    links[inst] = `https://example.com/${inst}`;
    run(cell => {
      cell.link = inst;
    });
    const at = 1 + int(out.length - 1);
    out.splice(at, 0, {ch: '\n', format: 0, link: 0, uid: uid++});
    // A line break is in a link only between two of its characters.
    const before = out[at - 1];
    const after = out[at + 1];
    if (
      before !== undefined &&
      after !== undefined &&
      before.link !== 0 &&
      before.link === after.link
    ) {
      out[at].link = before.link;
    }
    return out;
  };
  let blockId = 0;
  const text = (
    type: TextBlock['type'],
    content: Cell[],
    tag = '',
  ): TextBlock => ({
    cells: content,
    id: `b${blockId++}`,
    kind: 'text',
    tag,
    type,
  });
  const blocks: Block[] = [
    text('paragraph', sentence(6 + int(8), false)),
    text('heading', sentence(3 + int(4), false), 'h2'),
    text('paragraph', rich()),
    text('quote', rich()),
    {
      id: `b${blockId++}`,
      items: [0, 1, 2].map(i =>
        text('listitem', i === 1 ? rich() : sentence(3 + int(5), false)),
      ),
      kind: 'list',
    },
    {
      id: `b${blockId++}`,
      kind: 'table',
      rows: [0, 1].map(() =>
        [0, 1].map(i =>
          text('paragraph', i === 0 ? sentence(2 + int(4), false) : rich()),
        ),
      ),
    },
    text('paragraph', sentence(6 + int(6), true)),
    text('paragraph', sentence(4 + int(4), false)),
  ];
  const base: Doc = {baseUids: 0, blocks, links};
  (base as {baseUids: number}).baseUids = uid;

  const top =
    family === 'plain'
      ? blocks[0]
      : family === 'heading'
        ? blocks[1]
        : family === 'rich'
          ? blocks[2]
          : family === 'quote'
            ? blocks[3]
            : family === 'list'
              ? blocks[4]
              : family === 'table'
                ? blocks[5]
                : blocks[6];
  /** The text blocks under the target a side may edit. */
  const under =
    top.kind === 'text'
      ? [top]
      : top.kind === 'list'
        ? top.items
        : top.rows.flat();
  const mine = pick(under);
  const other = rand() < 0.6 ? mine : pick(under);
  // Where the other side edits, relative to the user: far in the block,
  // anywhere, or at the same place.
  const mode = pick(['far', 'far', 'any', 'same'] as const);
  const focusMine = rand();
  const focusTheirs =
    mode === 'same'
      ? focusMine
      : mode === 'any'
        ? rand()
        : (focusMine + 0.35 + rand() * 0.3) % 1;

  const KINDS = [
    'insert',
    'insert',
    'delete',
    'replace',
    'format',
    'format',
    'link',
    'type',
    'structure',
  ] as const;
  const labels: string[][] = [[], []];
  const make = (
    side: 0 | 1,
    block: TextBlock,
    focus: number,
    words: readonly string[],
  ): Op | null => {
    const kind = pick(KINDS);
    const all = block.cells;
    const n = all.length;
    const at = Math.min(n, Math.floor(focus * (n + 1)));
    // A range of whole cells near the focus.
    const range = (max: number): Cell[] => {
      const from = Math.min(Math.max(0, n - 1), at);
      const length = 1 + int(max);
      return all.slice(from, from + length);
    };
    // The word at the focus.
    const word = (): Cell[] => {
      let from = Math.min(Math.max(0, n - 1), at);
      const boundary = (cell: Cell | undefined) =>
        cell === undefined || cell.ch === ' ' || cell.ch === '\n';
      if (boundary(all[from])) {
        return all.slice(from, from + 1).filter(cell => cell.ch !== '\n');
      }
      while (!boundary(all[from - 1])) {
        from--;
      }
      let to = from;
      while (!boundary(all[to])) {
        to++;
      }
      return all.slice(from, to);
    };
    const fresh = (count: number) => Array.from({length: count}, () => uid++);
    const typedText = (): string[] => {
      if (family === 'repeats') {
        // Text of the base's own letters, so a diff may place it anywhere
        // along a run. Each side has a letter the other never types.
        return chars(
          pick(side === 0 ? ['a', 'ab', 'aba', 'Y'] : ['b', 'ba', 'bb', 't']),
        );
      }
      const r = rand();
      const w = pick(words);
      return r < 0.15
        ? ['\n']
        : r < 0.3
          ? chars(w.slice(0, 1))
          : r < 0.65
            ? chars(`${w} `)
            : chars(` ${w}`);
    };
    labels[side].push(kind);
    switch (kind) {
      case 'insert': {
        const content = typedText();
        const left = all[at - 1];
        return {
          extend:
            left !== undefined &&
            left.link !== 0 &&
            (all[at] === undefined || all[at].link !== left.link) &&
            rand() < 0.5,
          id: opId++,
          left: left === undefined ? null : left.uid,
          op: 'insert',
          right: all[at] === undefined ? null : all[at].uid,
          text: content,
          uids: fresh(content.length),
        };
      }
      case 'delete': {
        const gone = rand() < 0.5 ? word() : range(8);
        return gone.length === 0
          ? null
          : {id: opId++, op: 'delete', uids: gone.map(cell => cell.uid)};
      }
      case 'replace': {
        const gone = word();
        if (gone.length === 0) {
          return null;
        }
        const first = all.indexOf(gone[0]);
        const last = all.indexOf(gone[gone.length - 1]);
        const content =
          family === 'repeats' ? [side === 0 ? 'Y' : 't'] : chars(pick(words));
        // A word made again with some of its own letters cannot be told
        // from typing the other letters around those: only words that
        // share none are replaced, so the edit reads one way.
        if (gone.some(cell => content.includes(cell.ch))) {
          return null;
        }
        return {
          id: opId++,
          left: first > 0 ? all[first - 1].uid : null,
          newUids: fresh(content.length),
          op: 'replace',
          right: last + 1 < n ? all[last + 1].uid : null,
          text: content,
          uids: gone.map(cell => cell.uid),
        };
      }
      case 'format': {
        const bit = pick([1, 2]);
        const over = (rand() < 0.5 ? word() : range(14)).filter(
          cell => cell.ch !== '\n',
        );
        if (over.length === 0) {
          return null;
        }
        const value = (over[0].format & bit) === 0;
        return {
          bit,
          flips: over
            .filter(cell => ((cell.format & bit) !== 0) !== value)
            .map(cell => cell.uid),
          id: opId++,
          op: 'format',
          value,
        };
      }
      case 'link': {
        const insts = Array.from(
          new Set(all.map(cell => cell.link).filter(inst => inst !== 0)),
        );
        if (insts.length > 0 && rand() < 0.7) {
          const inst = pick(insts);
          return rand() < 0.75
            ? {
                id: opId++,
                inst,
                op: 'relink',
                url: `https://example.com/${side === 0 ? 'yours' : 'theirs'}/${opId}`,
              }
            : {id: opId++, inst, op: 'unlink'};
        }
        const over = word().filter(cell => cell.link === 0);
        if (over.length === 0) {
          return null;
        }
        return {
          flips: over.map(cell => cell.uid),
          id: opId++,
          inst: ++link,
          op: 'link',
          url: `https://example.com/new/${side === 0 ? 'yours' : 'theirs'}/${opId}`,
        };
      }
      case 'type': {
        if (top.kind !== 'text') {
          return null;
        }
        const to = pick(
          (
            [
              ['paragraph', ''],
              ['heading', 'h1'],
              ['heading', 'h2'],
              ['quote', ''],
            ] as const
          ).filter(([type, tag]) => type !== top.type || tag !== top.tag),
        );
        return {block: top.id, id: opId++, op: 'type', tag: to[1], type: to[0]};
      }
      case 'structure': {
        if (top.kind === 'table') {
          return {
            id: opId++,
            op: 'addRow',
            row: [0, 1].map(() => text('paragraph', cells(chars(pick(words))))),
            table: top.id,
          };
        }
        const r = rand();
        if (top.kind === 'list' && r < 0.3) {
          return {
            after: block.id,
            id: opId++,
            item: text('listitem', cells(chars(pick(words)))),
            list: top.id,
            op: 'addItem',
          };
        }
        if (top.kind === 'list' && r < 0.45) {
          return {id: opId++, item: block.id, op: 'removeItem'};
        }
        // Split the block, or join the next one into it.
        const list: readonly Block[] = top.kind === 'list' ? top.items : blocks;
        const next = list[list.indexOf(block) + 1];
        if (r < 0.75 || next === undefined || next.kind !== 'text') {
          const index = Math.min(Math.max(1, at), n - 1);
          return n < 2
            ? null
            : {
                at: all[index].uid,
                id: opId++,
                newId: `n${side}x${opId}`,
                op: 'split',
              };
        }
        return {block: block.id, id: opId++, next: next.id, op: 'join'};
      }
    }
  };
  const side = (
    which: 0 | 1,
    block: TextBlock,
    focus: number,
    words: readonly string[],
  ): Op[] => {
    const ops: Op[] = [];
    const count = rand() < 0.35 ? 2 : 1;
    for (let tries = 0; ops.length < count && tries < 20; tries++) {
      const before = labels[which].length;
      const op = make(which, block, ops.length === 0 ? focus : rand(), words);
      // An edit made against the base that the side's earlier edit undid
      // (text typed where it removed both neighbours) is not made, nor
      // one that leaves the side's edits with a shorter reading.
      if (op === null || !readsOneWay(base, [...ops, op])) {
        labels[which].length = before;
      } else {
        ops.push(op);
      }
    }
    return ops;
  };
  const yours = side(0, mine, focusMine, YOUR_WORDS);
  const theirs = side(1, other, focusTheirs, THEIR_WORDS);
  // One in eight: an edit of the user's did reach the server, so the
  // document holds it beside what the other side did.
  if (
    yours.length > 0 &&
    rand() < 0.125 &&
    applyAll(base, [yours[0], ...theirs]) !== null
  ) {
    theirs.unshift(yours[0]);
    labels[1].unshift('arrived');
  }
  return {
    base,
    family,
    label: `${labels[0].slice().sort().join('+')} | ${labels[1]
      .slice()
      .sort()
      .join('+')}`,
    seed,
    target: top.id,
    theirs,
    yours,
  };
}

// ---------------------------------------------------------------------------
// The oracle

/** `doc` with no format and no link on the text typed since the base. */
function withoutTypedFormat(doc: Doc): Doc {
  const copy = cloneDoc(doc);
  for (const block of textBlocks(copy)) {
    for (const cell of block.cells) {
      if (cell.uid >= doc.baseUids) {
        cell.format = 0;
        cell.link = 0;
      }
    }
  }
  return copy;
}

export interface Expected {
  /**
   * What the model says of the target block. `commute`: both orders of
   * applying the two sides' edits make one block, so a merge must make it. `typed-format`: the orders differ
   * only in the format of text typed at the edge of a range the other side
   * formatted, so a merge must make one of the two. `order`: the orders
   * differ otherwise, or an edit fails after the other side's: a merge
   * must not be made.
   */
  readonly kind: 'commute' | 'typed-format' | 'order';
  /** The documents a merge may make, as top-level JSON by block id. */
  readonly allowed: readonly ReadonlyMap<string, string>[];
  /**
   * Blocks the two orders make alike but for the format of typed text, as
   * each order makes them: a merge may give each typed character either.
   */
  readonly either: readonly ReadonlyMap<string, readonly [unknown, unknown]>[];
  /** Whether an allowed document counts one edit for two that cannot be told apart. */
  readonly coincident: boolean;
}

/** Whether `made` is `a` or `b`, or has of each character what one of the two has. */
function mixes(made: unknown, a: unknown, b: unknown): boolean {
  if (canonical(a) === canonical(b)) {
    return canonical(made) === canonical(a);
  }
  if (Array.isArray(made) && Array.isArray(a) && Array.isArray(b)) {
    return (
      made.length === a.length &&
      made.length === b.length &&
      made.every((item, i) => mixes(item, a[i], b[i]))
    );
  }
  type Shown = {blocks?: unknown; cells?: unknown[]};
  const m = made as Shown | null;
  const x = a as Shown | null;
  const y = b as Shown | null;
  if (
    m !== null &&
    x !== null &&
    y !== null &&
    Array.isArray(m.cells) &&
    Array.isArray(x.cells) &&
    Array.isArray(y.cells)
  ) {
    // A block: the same but for its cells and the blocks it holds.
    const bare = (shown: Shown) => canonical({...shown, blocks: 0, cells: 0});
    const xs = x.cells;
    const ys = y.cells;
    return (
      bare(m) === bare(x) &&
      bare(m) === bare(y) &&
      m.cells.length === xs.length &&
      m.cells.length === ys.length &&
      m.cells.every(
        (cell, i) =>
          canonical(cell) === canonical(xs[i]) ||
          canonical(cell) === canonical(ys[i]),
      ) &&
      mixes(m.blocks, x.blocks, y.blocks)
    );
  }
  return false;
}

/** Whether the model allows the block `id` to be merged into `merged`. */
export function isExpected(
  want: Expected,
  id: string,
  merged: SerializedLexicalNode,
): boolean {
  const shown = project(merged);
  const made = canonical(shown);
  return (
    want.allowed.some(doc => doc.get(id) === made) ||
    want.either.some(doc => {
      const pair = doc.get(id);
      return pair !== undefined && mixes(shown, pair[0], pair[1]);
    })
  );
}

const shownById = (doc: Doc): Map<string, unknown> => {
  const map = new Map<string, unknown>();
  const json = docJSON(doc);
  doc.blocks.forEach((block, i) => map.set(block.id, project(json[i])));
  return map;
};

const byBlockId = (doc: Doc): Map<string, string> => {
  const map = new Map<string, string>();
  const json = docJSON(doc);
  doc.blocks.forEach((block, i) =>
    map.set(block.id, canonical(project(json[i]))),
  );
  return map;
};

/** What the model says the two sides' edits make together. */
export function expected(c: Case): Expected {
  const allowed: Map<string, string>[] = [];
  const either: Map<string, readonly [unknown, unknown]>[] = [];
  // A block the two sides hold alike is the merge of itself (an edit of
  // the user's that arrived, a split both made), whatever else differs.
  const yoursDoc = applyAll(c.base, c.yours);
  const nowDoc = applyAll(c.base, c.theirs);
  if (yoursDoc !== null && nowDoc !== null) {
    const mine = byBlockId(yoursDoc);
    const held = new Map<string, string>();
    for (const [id, block] of byBlockId(nowDoc)) {
      if (mine.get(id) === block) {
        held.set(id, block);
      }
    }
    allowed.push(held);
  }
  const both = (yours: readonly Op[], theirs: readonly Op[]) => {
    const one = applyAll(c.base, [...yours, ...theirs]);
    const two = applyAll(c.base, [...theirs, ...yours]);
    if (one === null || two === null) {
      return 'order' as const;
    }
    const first = byBlockId(one);
    const second = byBlockId(two);
    if (canonical(docJSON(one)) === canonical(docJSON(two))) {
      allowed.push(first);
      return 'commute' as const;
    }
    // Block by block: the blocks both orders make alike are well defined,
    // whatever the rest of the document (a split's new block takes its
    // type from the block as it is when the split is applied), and a
    // block that differs only in the format of typed text may be either.
    const plainFirst = byBlockId(withoutTypedFormat(one));
    const plainSecond = byBlockId(withoutTypedFormat(two));
    const shownFirst = shownById(one);
    const shownSecond = shownById(two);
    const alike = new Map<string, string>();
    const mixed = new Map<string, readonly [unknown, unknown]>();
    for (const [id, block] of first) {
      if (second.get(id) === block) {
        alike.set(id, block);
      } else if (second.has(id) && plainFirst.get(id) === plainSecond.get(id)) {
        mixed.set(id, [shownFirst.get(id), shownSecond.get(id)]);
      }
    }
    allowed.push(alike);
    either.push(mixed);
    return mixed.has(c.target)
      ? ('typed-format' as const)
      : alike.has(c.target)
        ? ('commute' as const)
        : ('order' as const);
  };
  // An edit that leaves no trace in its own side's document (text made
  // italic in a list item the same side then removed) is not one a report
  // could know of.
  const seen = (ops: readonly Op[]) => {
    const made = (list: readonly Op[]) => {
      const doc = applyAll(c.base, list);
      return doc === null ? null : canonical(docJSON(doc));
    };
    const all = made(ops);
    return ops.filter(op => made(ops.filter(o => o !== op)) !== all);
  };
  const yoursSeen = seen(c.yours);
  const theirsSeen = seen(c.theirs);
  let kind = both(c.yours, c.theirs);
  if (
    yoursSeen.length < c.yours.length ||
    theirsSeen.length < c.theirs.length
  ) {
    const made = both(yoursSeen, theirsSeen);
    kind = kind === 'order' ? made : kind;
  }
  // Two edits that make the same block of the base cannot be told apart
  // from one edit that arrived: counted once, as D125 reads them (two
  // deletions of one letter of a pair; two joins of the same blocks).
  const alone = (op: Op) => {
    const doc = applyAll(c.base, [op]);
    return doc === null ? null : (byBlockId(doc).get(c.target) ?? null);
  };
  let coincident = false;
  const once = (yours: readonly Op[], theirs: readonly Op[]) => {
    coincident = true;
    const made = both(yours, theirs);
    kind = kind === 'order' ? made : kind;
  };
  for (const mine of c.yours) {
    for (const theirs of c.theirs) {
      const made = alone(mine);
      if (mine.id !== theirs.id && made !== null && made === alone(theirs)) {
        once(
          c.yours,
          c.theirs.filter(op => op !== theirs),
        );
        once(
          c.yours.filter(op => op !== mine),
          c.theirs,
        );
      }
    }
  }
  // Text one side removed that the other side also took out of its block
  // (removed, or moved to another block with a split or a join) is out of
  // that block on both sides: a block compared alone holds the same
  // change twice, counted once. What the other side moved stays where it
  // put it, as when a whole block is compared (D125).
  const home = new Map<number, string>();
  for (const block of textBlocks(c.base)) {
    for (const cell of block.cells) {
      home.set(cell.uid, block.id);
    }
  }
  const tookOut = (op: Op, other: readonly Op[]): boolean => {
    const doc = applyAll(c.base, other);
    if (doc === null || (op.op !== 'delete' && op.op !== 'removeItem')) {
      return false;
    }
    const uids =
      op.op === 'delete'
        ? op.uids
        : textBlocks(c.base)
            .filter(block => block.id === op.item)
            .flatMap(block => block.cells.map(cell => cell.uid));
    const blocks = new Map(textBlocks(doc).map(block => [block.id, block]));
    return uids.every(uid => {
      const block = blocks.get(home.get(uid)!);
      return block === undefined || !block.cells.some(cell => cell.uid === uid);
    });
  };
  const mineOut = yoursSeen.filter(op => tookOut(op, c.theirs));
  const theirsOut = theirsSeen.filter(op => tookOut(op, c.yours));
  if (mineOut.length > 0) {
    once(
      yoursSeen.filter(op => !mineOut.includes(op)),
      theirsSeen,
    );
  }
  if (theirsOut.length > 0) {
    once(
      yoursSeen,
      theirsSeen.filter(op => !theirsOut.includes(op)),
    );
  }
  // A block alone: the edits that do not show in a block on their own
  // side (text typed into what the same side split off to a new block)
  // are no part of that block's merge, whatever they do to the document
  // in the other order.
  if (yoursDoc !== null && nowDoc !== null) {
    const base = byBlockId(c.base);
    const mine = byBlockId(yoursDoc);
    const theirs = byBlockId(nowDoc);
    const shows = (ops: readonly Op[], id: string) => {
      const made = (list: readonly Op[]) => {
        const doc = applyAll(c.base, list);
        return doc === null ? null : (byBlockId(doc).get(id) ?? null);
      };
      const all = made(ops);
      return ops.filter(op => made(ops.filter(o => o !== op)) !== all);
    };
    for (const [id, block] of mine) {
      const was = base.get(id);
      const other = theirs.get(id);
      if (
        was !== undefined &&
        other !== undefined &&
        block !== was &&
        other !== was
      ) {
        const yoursOf = shows(c.yours, id);
        const theirsOf = shows(c.theirs, id);
        if (
          yoursOf.length < c.yours.length ||
          theirsOf.length < c.theirs.length
        ) {
          const allowedBefore = allowed.length;
          const eitherBefore = either.length;
          const made = both(yoursOf, theirsOf);
          // Only this block is judged by these edits.
          for (const map of allowed.splice(allowedBefore)) {
            const one = map.get(id);
            if (one !== undefined) {
              allowed.push(new Map([[id, one]]));
            }
          }
          for (const map of either.splice(eitherBefore)) {
            const pair = map.get(id);
            if (pair !== undefined) {
              either.push(new Map([[id, pair]]));
            }
          }
          if (id === c.target && kind === 'order') {
            kind = made;
          }
        }
      }
    }
  }
  return {allowed, coincident, either, kind};
}

// ---------------------------------------------------------------------------
// One case through the report

export interface Outcome {
  readonly kind: Expected['kind'];
  /** The target block's entry without the merge, and with it. */
  readonly before: string;
  readonly after: string;
  /** Why the target is a conflict with the merge on, when it is. */
  readonly conflict: string | null;
  readonly conflictDetail: string | null;
  /** What is wrong, in words; empty when the case holds. */
  readonly violations: string[];
}

/** Run a case through describeBlocks, with the merge off and on, and check it. */
export function runCase(c: Case): Outcome {
  const yoursDoc = applyAll(c.base, c.yours);
  const nowDoc = applyAll(c.base, c.theirs);
  if (yoursDoc === null || nowDoc === null) {
    throw new Error(`case ${c.seed}: a side's own edits do not apply`);
  }
  const input = {
    base: docJSON(c.base),
    kinds: CORPUS_KINDS,
    now: docJSON(nowDoc),
    yours: docJSON(yoursDoc),
  };
  const off = describeBlocks({...input, blockMerge: false});
  const on = describeBlocks({...input, blockMerge: true});
  const want = expected(c);
  const violations: string[] = [];
  const say = (block: (typeof on)[number] | undefined) =>
    block === undefined
      ? 'unchanged'
      : block.resolution === 'merged' &&
          canonical(block.merged) === canonical(block.now)
        ? 'in-document'
        : (block.resolution as string);
  if (off.length !== on.length) {
    violations.push('the merge changed which blocks are reported');
  }
  on.forEach((block, i) => {
    const was = off[i];
    if (was === undefined || was.id !== block.id) {
      return;
    }
    // The merge only ever turns a conflict into a merge.
    if (
      say(was) !== say(block) &&
      !(
        say(was) === 'conflict' &&
        (say(block) === 'merged' || say(block) === 'in-document')
      )
    ) {
      violations.push(`block ${block.id} was ${say(was)} and is ${say(block)}`);
    }
    if (block.resolution === 'merged' && block.merged != null) {
      if (!isExpected(want, block.id, block.merged)) {
        violations.push(
          `block ${block.id} merged into what neither order of the edits makes (${
            want.kind
          }): ${canonical(project(block.merged))}`,
        );
      }
    }
  });
  const target = on.find(block => block.id === c.target);
  return {
    after: say(target),
    before: say(off.find(block => block.id === c.target)),
    conflict:
      target !== undefined && target.resolution === 'conflict'
        ? (target.conflict ?? null)
        : null,
    conflictDetail:
      target !== undefined && target.resolution === 'conflict'
        ? (target.conflictDetail ?? null)
        : null,
    kind: want.kind,
    violations,
  };
}
