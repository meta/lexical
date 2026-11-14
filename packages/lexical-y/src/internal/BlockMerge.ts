/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The three-way merge of one block (D133): the block as the user had it
// (yours), as the document they edited held it (base) and as the document
// holds it now, all as Lexical JSON, into one block that holds both sides'
// changes, or a conflict. It reads no Yjs type and knows no layout: the
// reads that describeUnsyncedEdits already makes are its input.
//
// A block that holds text is merged as a sequence of tokens (a character
// with its node's properties, or one token for a line break, a tab, a
// decorator or a token-mode text node) by diff3: node-diff3's
// diff3MergeRegions (Diff3.ts), over the tokens grouped into words
// and compared by content only, then a second pass that merges each kept
// token's properties three ways. A change one side made is taken, the same
// change on both sides is taken once, and anything else that overlaps or
// touches is a conflict. A block that holds blocks is merged by diff3 too,
// over its children's block ids. Whatever cannot be shown to be safe is a
// conflict, and the block goes to the panel as it did before.

import type {SerializedLexicalNode} from 'lexical';

import {diff3MergeRegions, diffIndices, type IRegion} from './Diff3';

/** What a node type is in the editor that read the documents. */
export type NodeKind =
  | 'text'
  | 'tab'
  | 'linebreak'
  | 'inline-leaf'
  | 'inline-element'
  | 'block-element'
  | 'block-leaf'
  /** Instances of the type differ (some inline, some not): never merged. */
  | 'mixed';

/** Node type to kind, for every type the three documents hold. */
export type NodeKinds = ReadonlyMap<string, NodeKind>;

/** @experimental How a replay treats a block (see YUnsyncedBlock). */
export type YUnsyncedResolution = 'whole' | 'merged' | 'conflict';

/** @experimental Why a block is left for the panel (see YUnsyncedBlock). */
export type YUnsyncedConflict =
  /** The base is gone, so nothing says who changed what. */
  | 'no-base'
  /** The documents' blocks have no ids, so they are matched by position. */
  | 'no-block-ids'
  /** Both sides changed the block and `blockMerge` is off. */
  | 'block-merge-off'
  /** One side added or deleted the block and the other changed it. */
  | 'added-or-deleted'
  /** Both sides changed the same content, or content that touches. */
  | 'overlap'
  /** Both sides changed the formatting, style or state of the same content. */
  | 'format'
  /** Both sides changed the same property of an element. */
  | 'property'
  /** Both sides changed which blocks a container holds, or one removed a block the other changed. */
  | 'structure'
  /** The block holds a shape the merge does not read (see `conflictDetail`). */
  | 'unsupported'
  /** A merge was made and failed a check, so it was dropped. */
  | 'unverified';

/** @experimental One block a user changed (see YUnsyncedReport). */
export interface YUnsyncedBlock {
  /** The block id (BlockIdExtension), or `'#<index>'` where blocks have none. */
  readonly id: string;
  readonly change: 'added' | 'changed' | 'deleted';
  /** The block as the user had it, null when they deleted it. */
  readonly yours: SerializedLexicalNode | null;
  /** The block in the document the edits were made against. */
  readonly base: SerializedLexicalNode | null;
  /** The block in the document as it is now. */
  readonly now: SerializedLexicalNode | null;
  /**
   * Whether the current document still matches the base for this block (the
   * check an edit by block id uses, D94): a replay writes `yours` over it.
   * Always false without a base or without block ids.
   */
  readonly replayable: boolean;
  /**
   * What a replay does with the block: `'whole'` (`replayable`: `yours`
   * replaces the current block), `'merged'` (both sides changed it and
   * their changes do not overlap: `merged` replaces the current block) or
   * `'conflict'` (left for the panel, with why in `conflict`). Always set by
   * `describeUnsyncedEdits`.
   */
  readonly resolution?: YUnsyncedResolution;
  /**
   * With resolution `'merged'`, the block that holds both sides' changes
   * (equal to `now` when the document already holds the user's: there is
   * nothing to write then); null otherwise, and when both sides deleted the
   * block.
   */
  readonly merged?: SerializedLexicalNode | null;
  /** With resolution `'conflict'`, why. */
  readonly conflict?: YUnsyncedConflict;
  /** A sentence for a log that says what the conflict is. Its wording is not API. */
  readonly conflictDetail?: string;
}

type Json = SerializedLexicalNode;
type Props = Record<string, unknown>;

/** The most tokens of one block's text the merge reads. */
export const BLOCK_MERGE_MAX_TOKENS = 10000;

class Conflict {
  constructor(
    readonly conflict: YUnsyncedConflict,
    readonly detail: string,
  ) {}
}

function fail(conflict: YUnsyncedConflict, detail: string): never {
  throw new Conflict(conflict, detail);
}

const ABSENT = '\u0000';

/** `value` as JSON with sorted keys: equal for equal values, whatever their key order. */
export function canonical(value: unknown): string {
  const text = JSON.stringify(value, (_key, v: unknown) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      // No prototype: a `__proto__` key is a key like any other.
      const sorted: Props = Object.create(null);
      for (const key of Object.keys(v).sort()) {
        sorted[key] = (v as Props)[key];
      }
      return sorted;
    }
    return v;
  });
  return text === undefined ? ABSENT : text;
}

/** `object[key]` when `object` has it as its own key (NodeState may hold `valueOf`). */
const own = (object: Props, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;

const isObject = (value: unknown): value is Props =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function blockIdOf(node: Json): string | null {
  const state = (node as {$?: {blockId?: unknown}}).$;
  const id = isObject(state) ? state.blockId : undefined;
  return typeof id === 'string' && id !== '' ? id : null;
}

function childrenOf(node: Json): Json[] | null {
  const children = (node as {children?: unknown}).children;
  return Array.isArray(children) ? (children as Json[]) : null;
}

// ---------------------------------------------------------------------------
// Properties

/**
 * The properties of one node merged three ways, one by one: a property one
 * side changed takes that side's value, one both changed alike takes it
 * once, and one both changed differently is a conflict. Two exceptions
 * merge inside a property: a text format (`format`, and an element's
 * `textFormat`) is a set of bits, each merged as its own property, and
 * NodeState (`$`) is merged key by key (`isState`: the keys of that state,
 * plain keys whatever their names).
 */
function mergeProps(
  b: Props,
  y: Props,
  n: Props,
  conflict: YUnsyncedConflict,
  what: string,
  isState = false,
): Props {
  const keys = new Set([
    ...Object.keys(n),
    ...Object.keys(y),
    ...Object.keys(b),
  ]);
  const merged: Props = {};
  for (const key of keys) {
    const vb = own(b, key);
    const vy = own(y, key);
    const vn = own(n, key);
    const kb = canonical(vb);
    const ky = canonical(vy);
    const kn = canonical(vn);
    let value: unknown;
    if (ky === kn || ky === kb) {
      value = vn;
    } else if (kn === kb) {
      value = vy;
    } else if (
      !isState &&
      (key === 'format' || key === 'textFormat') &&
      typeof vb === 'number' &&
      typeof vy === 'number' &&
      typeof vn === 'number'
    ) {
      value = vb ^ ((vb ^ vy) | (vb ^ vn));
      checkExclusive(value as number, [vy, vn], what);
    } else if (
      !isState &&
      key === '$' &&
      (vb === undefined || isObject(vb)) &&
      (vy === undefined || isObject(vy)) &&
      (vn === undefined || isObject(vn))
    ) {
      const state = mergeProps(
        vb || {},
        vy || {},
        vn || {},
        conflict,
        `${what}, state`,
        true,
      );
      value = Object.keys(state).length === 0 ? undefined : state;
    } else {
      fail(conflict, `${what}: both sides changed "${key}", differently`);
    }
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Format bits of which a text has at most one: subscript and superscript;
 * lowercase, uppercase and capitalize (`toggleTextFormatType` clears the
 * others when it sets one).
 */
// Subscript (32) with superscript (64), and lowercase (256), uppercase (512)
// and capitalize (1024): literals, which a bundler drops when unused.
const EXCLUSIVE_FORMATS: readonly number[] = [96, 1792];

/**
 * Fails when a merged format holds two bits of one exclusive group that no
 * side held together (subscript by one side, superscript by the other):
 * one person's choice would silently not show.
 */
function checkExclusive(
  value: number,
  sides: readonly unknown[],
  what: string,
): void {
  for (const group of EXCLUSIVE_FORMATS) {
    const bits = value & group;
    if (
      (bits & (bits - 1)) !== 0 &&
      !sides.some(side => typeof side === 'number' && (side & group) === bits)
    ) {
      fail('format', `${what}: both sides chose a different case or script`);
    }
  }
}

/** An element's own properties (its JSON with no children). */
const elementProps = (node: Json): Props => ({...node, children: []});

/**
 * An element's own properties merged (see mergeProps). A side that changed
 * the element's type changed what its other properties mean, so the other
 * side may then have changed none of them.
 */
function mergeElementProps(b: Json, y: Json, n: Json): Props {
  const pb = elementProps(b);
  const py = elementProps(y);
  const pn = elementProps(n);
  if (y.type !== b.type || n.type !== b.type) {
    const kb = canonical(pb);
    const ky = canonical(py);
    const kn = canonical(pn);
    if (ky !== kb && kn !== kb && ky !== kn) {
      fail(
        'property',
        y.type !== b.type && n.type !== b.type
          ? `both sides changed the type of the ${b.type}, or one its type and the other a property`
          : `one side made the ${b.type} a ${
              y.type !== b.type ? y.type : n.type
            } and the other changed its properties`,
      );
    }
  }
  return mergeProps(pb, py, pn, 'property', `the ${b.type}`);
}

// ---------------------------------------------------------------------------
// Tokens

/** An inline element around a token (a link, a mark), outermost first. */
interface Wrap {
  /** The element's JSON with no children. */
  readonly props: Props;
  readonly key: string;
  /** Which element of its document it is. */
  readonly inst: number;
}

interface Token {
  /** What the diff compares: the character, or the kind of node. */
  readonly key: string;
  /** A character (an extended cluster) of a text node, or null. */
  readonly text: string | null;
  /**
   * The node's properties: a text node's with an empty `text`, any other
   * node's whole JSON.
   */
  readonly attrs: Props;
  readonly attrsKey: string;
  /** Whether `attrs` is one value (a decorator, a token-mode text node). */
  readonly opaque: boolean;
  readonly path: readonly Wrap[];
  readonly pathKey: string;
  /** Which leaf node of its document it is in. */
  readonly node: number;
}

/**
 * The extended clusters of `text`, near enough: a code point (or a pair of
 * regional indicators) with the marks, modifiers and joined code points
 * after it, so that a merge never separates a base character from its
 * accent or the parts of one emoji. Not Intl.Segmenter: every client must
 * cut alike.
 */
const CLUSTERS =
  /(?:\p{RI}\p{RI}|[^])(?:[\p{M}\p{Emoji_Modifier}]|\u200d[^])*/gu;
const PLAIN = /^[ -~]*$/;

function clusters(text: string): string[] {
  return PLAIN.test(text) ? text.split('') : text.match(CLUSTERS) || [];
}

/**
 * The tokens of a text block's children. Throws `unsupported` for what a
 * token sequence cannot hold: a type of unknown kind, a block, an empty
 * text node or inline element.
 */
function tokenize(children: readonly Json[], kinds: NodeKinds): Token[] {
  const tokens: Token[] = [];
  let node = 0;
  let inst = 0;
  const visit = (
    nodes: readonly Json[],
    path: readonly Wrap[],
    pathKey: string,
  ) => {
    for (const json of nodes) {
      const kind = kinds.get(json.type);
      const record = json as unknown as Props;
      if (kind === 'text' || kind === 'tab') {
        const text = record.text;
        if (typeof text !== 'string' || text === '' || 'children' in record) {
          fail('unsupported', `a ${json.type} node with no text`);
        }
        const mode = record.mode;
        if (kind === 'text' && (mode === undefined || mode === 'normal')) {
          const attrs = {...record, text: ''};
          const attrsKey = canonical(attrs);
          for (const cluster of clusters(text)) {
            tokens.push({
              attrs,
              attrsKey,
              key: `c${cluster}`,
              node,
              opaque: false,
              path,
              pathKey,
              text: cluster,
            });
          }
        } else {
          // A tab is one token whose properties merge like a character's;
          // a token-mode or segmented text node is one value.
          const opaque = kind === 'text';
          tokens.push({
            attrs: record,
            attrsKey: canonical(record),
            key: opaque ? `o${json.type}\u0000${text}` : `a${json.type}`,
            node,
            opaque,
            path,
            pathKey,
            text: null,
          });
        }
        node++;
      } else if (kind === 'linebreak' || kind === 'inline-leaf') {
        if ('children' in record) {
          fail('unsupported', `a ${json.type} node with children`);
        }
        const opaque = kind === 'inline-leaf';
        tokens.push({
          attrs: record,
          attrsKey: canonical(record),
          key: `${opaque ? 'o' : 'a'}${json.type}`,
          node,
          opaque,
          path,
          pathKey,
          text: null,
        });
        node++;
      } else if (kind === 'inline-element') {
        const inner = childrenOf(json);
        if (inner === null || inner.length === 0) {
          fail('unsupported', `an empty ${json.type}`);
        }
        const props = elementProps(json);
        const wrap: Wrap = {inst: inst++, key: canonical(props), props};
        const before = tokens.length;
        visit(inner, [...path, wrap], `${pathKey}\u0001${wrap.key}`);
        if (tokens.length === before) {
          fail('unsupported', `an empty ${json.type}`);
        }
      } else {
        fail(
          'unsupported',
          kind === undefined || kind === 'mixed'
            ? `a node type the merge does not know (${json.type})`
            : `a block (${json.type}) beside text`,
        );
      }
    }
  };
  visit(children, [], '');
  return tokens;
}

/** One token of a merged block. */
interface Out {
  readonly text: string | null;
  attrs: Props;
  attrsKey: string;
  readonly opaque: boolean;
  path: readonly Wrap[];
  pathKey: string;
  /** Its index in the base, yours and now, or -1. */
  readonly at: readonly [number, number, number];
  /** 0: both sides kept it; 1, 2: that side added it; 3: both added it. */
  readonly origin: 0 | 1 | 2 | 3;
}

type Sides = readonly [readonly Token[], readonly Token[], readonly Token[]];

/**
 * The children that `outs` are the tokens of. Two characters next to each
 * other with equal properties share a text node, and two tokens with equal
 * inline elements around them share those, unless a document that has the
 * two next to each other keeps them apart.
 */
function build(outs: readonly Out[], sides: Sides): Json[] {
  const apart = (prev: Out, cur: Out, depth: number): boolean => {
    for (let z = 0; z < 3; z++) {
      const a = prev.at[z];
      const c = cur.at[z];
      if (a < 0 || c !== a + 1) {
        continue;
      }
      const ta = sides[z][a];
      const tc = sides[z][c];
      if (depth < 0) {
        if (
          ta.attrsKey === tc.attrsKey &&
          ta.pathKey === tc.pathKey &&
          ta.node !== tc.node
        ) {
          return true;
        }
      } else if (ta.path.length > depth && tc.path.length > depth) {
        let same = true;
        for (let k = 0; k <= depth && same; k++) {
          same =
            ta.path[k].key === tc.path[k].key &&
            ta.path[k].key === cur.path[k].key;
        }
        if (same && ta.path[depth].inst !== tc.path[depth].inst) {
          return true;
        }
      }
    }
    return false;
  };
  const root: Json[] = [];
  const stack: Json[][] = [root];
  let prev: Out | null = null;
  let prevText: {text: string} | null = null;
  for (const cur of outs) {
    let depth = 0;
    if (prev !== null) {
      while (
        depth < prev.path.length &&
        depth < cur.path.length &&
        prev.path[depth].key === cur.path[depth].key &&
        !apart(prev, cur, depth)
      ) {
        depth++;
      }
    }
    const sameParent =
      prev !== null && depth === prev.path.length && depth === cur.path.length;
    stack.length = depth + 1;
    for (let d = depth; d < cur.path.length; d++) {
      const children: Json[] = [];
      stack[d].push({...cur.path[d].props, children} as unknown as Json);
      stack.push(children);
    }
    if (
      cur.text !== null &&
      prev !== null &&
      prevText !== null &&
      sameParent &&
      prev.attrsKey === cur.attrsKey &&
      !apart(prev, cur, -1)
    ) {
      prevText.text += cur.text;
    } else if (cur.text !== null) {
      const made = {...cur.attrs, text: cur.text};
      prevText = made;
      stack[stack.length - 1].push(made as unknown as Json);
    } else {
      prevText = null;
      stack[stack.length - 1].push(cur.attrs as unknown as Json);
    }
    prev = cur;
  }
  return root;
}

/** `tokens` as the tokens of a merge that changed nothing (side `z`). */
function asOuts(tokens: readonly Token[], z: 0 | 1 | 2): Out[] {
  return tokens.map((token, i) => ({
    at: [z === 0 ? i : -1, z === 1 ? i : -1, z === 2 ? i : -1],
    attrs: token.attrs,
    attrsKey: token.attrsKey,
    opaque: token.opaque,
    origin: 0,
    path: token.path,
    pathKey: token.pathKey,
    text: token.text,
  }));
}

// ---------------------------------------------------------------------------
// Alignment and merge: diff3

/**
 * A character that is part of a word. The diff3 compares words, not
 * characters: two sides' edits inside one word are one region, and a
 * rewritten word never keeps a letter or two of the old one by chance. A
 * character of a script written without spaces between words (Chinese,
 * Japanese, Thai, Lao, Khmer, Burmese) is a unit of its own.
 */
const WORD =
  /^(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}])[\p{L}\p{N}\p{M}_]/u;

/**
 * What diff3 aligns of a token sequence: units, each a word (a run of word
 * characters) or any other token alone, compared by content only (`keys`:
 * the text, or the kind of node). Unit `k` is tokens
 * `[starts[k], starts[k + 1])`.
 */
interface Units {
  readonly keys: string[];
  readonly starts: number[];
  /** Token index to unit index. */
  readonly unitOf: Int32Array;
}

function unitsOf(tokens: readonly Token[], byWord: boolean): Units {
  const keys: string[] = [];
  const starts: number[] = [];
  const unitOf = new Int32Array(tokens.length);
  let inWord = false;
  tokens.forEach((token, i) => {
    const word = byWord && token.text !== null && WORD.test(token.text);
    if (word && inWord) {
      // Token by token: `é` as one character and as `e` and an accent
      // from two text nodes are different units.
      keys[keys.length - 1] += `\u0001${token.text}`;
    } else {
      starts.push(i);
      keys.push(word ? `w${token.text}` : token.key);
    }
    inWord = word;
    unitOf[i] = keys.length - 1;
  });
  starts.push(tokens.length);
  return {keys, starts, unitOf};
}

/**
 * The most tokens one side may add or remove. With BLOCK_MERGE_MAX_TOKENS,
 * it bounds the LCS's cost, which grows with how far two sequences differ:
 * past it, a block is a conflict (`unsupported`) rather than a merge that
 * takes seconds.
 */
export const BLOCK_MERGE_MAX_EDITS = 5000;

interface Hunk {
  /** `[start, length]` in the base. */
  readonly buffer1: readonly [number, number];
  /** `[start, length]` in the side. */
  readonly buffer2: readonly [number, number];
}

/**
 * diff3MergeRegions of `a`, `o` and `b`, and the diffIndices of `o` to
 * `a` and to `b` it is made from (the same LCS, so the regions and the
 * hunks agree).
 */
function align3(
  a: readonly string[],
  o: readonly string[],
  b: readonly string[],
): {found: IRegion<string>[]; hunks: readonly [Hunk[], Hunk[]]} {
  return {
    found: diff3MergeRegions(a, o, b),
    hunks: [diffIndices(o, a), diffIndices(o, b)],
  };
}

/**
 * Base unit to side unit, -1 where the side removed it, from the same
 * diffIndices that diff3MergeRegions runs (so the two agree).
 */
function unitMap(length: number, hunks: readonly Hunk[]): Int32Array {
  const map = new Int32Array(length).fill(-1);
  let b = 0;
  let s = 0;
  for (const hunk of hunks) {
    const [bStart, bLength] = hunk.buffer1;
    const [sStart, sLength] = hunk.buffer2;
    if (bStart - b !== sStart - s) {
      fail('unverified', 'the diff does not align the kept text');
    }
    while (b < bStart) {
      map[b++] = s++;
    }
    b = bStart + bLength;
    s = sStart + sLength;
  }
  while (b < length) {
    map[b++] = s++;
  }
  return map;
}

/**
 * Base token to side token, -1 where the side removed it: kept words map
 * token by token, and inside what a side changed, the characters it kept
 * are found by a second diff over characters (so typing inside a word
 * keeps the word's other letters, with their format). Uses the same
 * diffIndices as diff3MergeRegions, so the two agree on the words.
 */
function tokenMap(
  base: readonly Token[],
  side: readonly Token[],
  units: readonly [Units, Units],
  unitHunks: readonly Hunk[],
): Int32Array {
  const [bu, su] = units;
  const map = new Int32Array(base.length).fill(-1);
  const keep = (bFrom: number, sFrom: number, length: number) => {
    for (let k = 0; k < length; k++) {
      map[bFrom + k] = sFrom + k;
    }
  };
  let b = 0;
  let s = 0;
  const hunks: Hunk[] = [
    ...unitHunks,
    {buffer1: [bu.keys.length, 0], buffer2: [su.keys.length, 0]},
  ];
  for (const hunk of hunks) {
    const [bStart, bLength] = hunk.buffer1;
    const [sStart, sLength] = hunk.buffer2;
    if (
      bStart - b !== sStart - s ||
      bu.starts[bStart] - bu.starts[b] !== su.starts[sStart] - su.starts[s]
    ) {
      fail('unverified', 'the diff does not align the kept text');
    }
    keep(bu.starts[b], su.starts[s], bu.starts[bStart] - bu.starts[b]);
    const bFrom = bu.starts[bStart];
    const bTo = bu.starts[bStart + bLength];
    const sFrom = su.starts[sStart];
    const sTo = su.starts[sStart + sLength];
    if (bLength > 0 && sLength > 0) {
      if (
        bTo - bFrom > BLOCK_MERGE_MAX_EDITS ||
        sTo - sFrom > BLOCK_MERGE_MAX_EDITS
      ) {
        fail(
          'unsupported',
          `more than ${BLOCK_MERGE_MAX_EDITS} characters added or removed`,
        );
      }
      const bKeys = base.slice(bFrom, bTo).map(token => token.key);
      const sKeys = side.slice(sFrom, sTo).map(token => token.key);
      let bb = 0;
      let ss = 0;
      for (const inner of diffIndices(bKeys, sKeys)) {
        keep(bFrom + bb, sFrom + ss, inner.buffer1[0] - bb);
        bb = inner.buffer1[0] + inner.buffer1[1];
        ss = inner.buffer2[0] + inner.buffer2[1];
      }
      keep(bFrom + bb, sFrom + ss, bKeys.length - bb);
    }
    b = bStart + bLength;
    s = sStart + sLength;
  }
  return map;
}

/**
 * `yours` and `now` merged against `base`, as tokens, and whether a token
 * one side added took what the other side gave both its neighbours.
 * Throws a Conflict.
 *
 * diff3MergeRegions (node-diff3) splits the base into regions over the
 * three sides' units: kept by both (`o`), changed by one side only (`a`,
 * `b`: taken), or changed by both (a conflict, unless both made the same
 * change, which is taken once). In a region both kept, each token's
 * properties are merged three ways (mergeProps): the second pass.
 */
function mergeTokens(
  sides: Sides,
  byWord = true,
): {outs: Out[]; inherited: boolean} {
  const [base, yours, now] = sides;
  const units = [
    unitsOf(base, byWord),
    unitsOf(yours, byWord),
    unitsOf(now, byWord),
  ] as const;
  const {found, hunks} = align3(units[1].keys, units[0].keys, units[2].keys);
  const maps = [
    tokenMap(base, yours, [units[0], units[1]], hunks[0]),
    tokenMap(base, now, [units[0], units[2]], hunks[1]),
  ] as const;
  const backs = maps.map((map, z) => {
    const back = new Int32Array(sides[z + 1].length).fill(-1);
    map.forEach((i, j) => {
      if (i >= 0) {
        back[i] = j;
      }
    });
    return back;
  });
  maps.forEach((map, z) => {
    let edits = sides[z + 1].length - base.length;
    map.forEach(i => {
      edits += i < 0 ? 2 : 0;
    });
    if (edits > BLOCK_MERGE_MAX_EDITS) {
      fail(
        'unsupported',
        `more than ${BLOCK_MERGE_MAX_EDITS} characters added or removed`,
      );
    }
  });
  /** The token of side `z` (1: yours, 2: now) that base token `j` is, or -1. */
  const at = (z: 1 | 2, j: number): number => maps[z - 1][j];
  const changed = (a: Token, b: Token) =>
    a.attrsKey !== b.attrsKey || a.pathKey !== b.pathKey;

  // Text one side removed, the other reformatted: it may have moved to
  // another block, where the new format would be lost.
  for (let j = 0; j < base.length; j++) {
    const yi = at(1, j);
    const ni = at(2, j);
    if (
      (yi < 0 && ni >= 0 && changed(now[ni], base[j])) ||
      (ni < 0 && yi >= 0 && changed(yours[yi], base[j]))
    ) {
      fail(
        'format',
        'one side removed text whose formatting, link or state the other changed',
      );
    }
  }

  const outs: Out[] = [];
  const kept = (j: number) => {
    const yi = at(1, j);
    const ni = at(2, j);
    const tb = base[j];
    const ty = yours[yi];
    const tn = now[ni];
    let attrs = tb.attrs;
    let attrsKey = tb.attrsKey;
    if (ty.attrsKey !== tb.attrsKey || tn.attrsKey !== tb.attrsKey) {
      if (ty.attrsKey === tn.attrsKey || tn.attrsKey === tb.attrsKey) {
        attrs = ty.attrs;
        attrsKey = ty.attrsKey;
      } else if (ty.attrsKey === tb.attrsKey) {
        attrs = tn.attrs;
        attrsKey = tn.attrsKey;
      } else if (tb.opaque) {
        fail('format', `both sides changed one ${String(tb.attrs.type)}`);
      } else {
        attrs = mergeProps(
          tb.attrs,
          ty.attrs,
          tn.attrs,
          'format',
          tb.text === null ? `a ${String(tb.attrs.type)}` : 'text',
        );
        attrsKey = canonical(attrs);
      }
    }
    let from = tb;
    if (ty.pathKey !== tb.pathKey || tn.pathKey !== tb.pathKey) {
      if (ty.pathKey === tn.pathKey || tn.pathKey === tb.pathKey) {
        from = ty;
      } else if (ty.pathKey === tb.pathKey) {
        from = tn;
      } else {
        fail(
          'format',
          'both sides changed the link or mark around the same text',
        );
      }
    }
    outs.push({
      at: [j, yi, ni],
      attrs,
      attrsKey,
      opaque: tb.opaque,
      origin: 0,
      path: from.path,
      pathKey: from.pathKey,
      text: tb.text,
    });
  };
  const added = (z: 1 | 2 | 3, token: Token, yi: number, ni: number) => {
    outs.push({
      at: [-1, yi, ni],
      attrs: token.attrs,
      attrsKey: token.attrsKey,
      opaque: token.opaque,
      origin: z,
      path: token.path,
      pathKey: token.pathKey,
      text: token.text,
    });
  };

  for (const region of found) {
    if (region.stable && region.buffer === 'o') {
      const from = units[0].starts[region.bufferStart];
      const to = units[0].starts[region.bufferStart + region.bufferLength];
      for (let j = from; j < to; j++) {
        kept(j);
      }
    } else if (region.stable) {
      const z = region.buffer === 'a' ? 1 : 2;
      const from = units[z].starts[region.bufferStart];
      const to = units[z].starts[region.bufferStart + region.bufferLength];
      for (let i = from; i < to; i++) {
        // A character this side kept inside a word it changed.
        const j = backs[z - 1][i];
        if (j >= 0) {
          kept(j);
        } else {
          added(z, sides[z][i], z === 1 ? i : -1, z === 2 ? i : -1);
        }
      }
    } else {
      // Both sides changed here: only the same change, read once.
      if (
        region.aLength !== region.bLength ||
        region.aContent.some((key, k) => key !== region.bContent[k])
      ) {
        fail(
          'overlap',
          'both sides changed the same text, or text that touches',
        );
      }
      const yFrom = units[1].starts[region.aStart];
      const yTo = units[1].starts[region.aStart + region.aLength];
      const nFrom = units[2].starts[region.bStart];
      for (let k = 0; yFrom + k < yTo; k++) {
        const j = backs[0][yFrom + k];
        if (j >= 0 && j === backs[1][nFrom + k]) {
          kept(j);
        } else {
          added(3, yours[yFrom + k], yFrom + k, nFrom + k);
        }
      }
    }
  }
  return inherit(outs, sides);
}

/** Whether two chains of inline elements are the same elements of their document. */
function sameWraps(a: readonly Wrap[], b: readonly Wrap[]): boolean {
  return a.length === b.length && a.every((wrap, k) => wrap.inst === b[k].inst);
}

interface Around {
  /** The neighbour in the base, the other side (`s`) and the adding side (`x`). */
  readonly b: {readonly attrs: Props};
  readonly s: {readonly attrs: Props};
  readonly x: {readonly attrs: Props};
}

/**
 * `given` (the properties of a token one side added) with what the other
 * side changed alike on both neighbours `l` and `r`: a format bit, a
 * property whose value the token shared with a neighbour on its own side,
 * and NodeState (`$`) key by key (`isState`: `given` is that state, whose
 * keys are plain keys, whatever their names).
 */
function inheritProps(
  given: Props,
  l: Around,
  r: Around,
  isState = false,
): Props {
  let props = given;
  const set = (key: string, value: unknown) => {
    props = {...props};
    if (value === undefined) {
      delete props[key];
    } else {
      props[key] = value;
    }
  };
  const keys = new Set([
    ...Object.keys(l.b.attrs),
    ...Object.keys(l.s.attrs),
    ...Object.keys(r.b.attrs),
    ...Object.keys(r.s.attrs),
  ]);
  if (!isState) {
    keys.delete('text');
  }
  for (const key of keys) {
    const lb = own(l.b.attrs, key);
    const ls = own(l.s.attrs, key);
    const rb = own(r.b.attrs, key);
    const rs = own(r.s.attrs, key);
    const mine = own(given, key);
    if (key === 'format' && !isState) {
      if (
        typeof lb === 'number' &&
        typeof ls === 'number' &&
        typeof rb === 'number' &&
        typeof rs === 'number' &&
        typeof mine === 'number'
      ) {
        const mask = (lb ^ ls) & (rb ^ rs) & ~(ls ^ rs);
        if (mask !== 0 && (mine & mask) !== (ls & mask)) {
          const value = (mine & ~mask) | (ls & mask);
          checkExclusive(value, [mine, ls], 'typed text');
          set(key, value);
        }
      }
    } else if (
      key === '$' &&
      !isState &&
      [lb, ls, rb, rs, mine, l.x.attrs.$, r.x.attrs.$].every(
        value => value === undefined || isObject(value),
      )
    ) {
      const state = (side: {readonly attrs: Props}) => ({
        attrs: (side.attrs.$ as Props | undefined) || {},
      });
      const merged = inheritProps(
        (mine as Props | undefined) || {},
        {b: state(l.b), s: state(l.s), x: state(l.x)},
        {b: state(r.b), s: state(r.s), x: state(r.x)},
        true,
      );
      if (canonical(merged) !== canonical(mine || {})) {
        set(key, Object.keys(merged).length === 0 ? undefined : merged);
      }
    } else if (
      canonical(ls) !== canonical(lb) &&
      canonical(rs) !== canonical(rb) &&
      canonical(ls) === canonical(rs) &&
      canonical(mine) !== canonical(ls) &&
      (canonical(mine) === canonical(own(l.x.attrs, key)) ||
        canonical(mine) === canonical(own(r.x.attrs, key)))
    ) {
      set(key, ls);
    }
  }
  return props;
}

/**
 * Text one side added between two tokens the other side changed alike
 * takes that change too (bold typed into a range the other side made
 * italic is bold italic; a word typed into a link whose URL the other side
 * changed is in that link). At the edge of such a range, and at the edge of
 * the block, it keeps its own format; text typed inside a link at its edge
 * while the other side changed that link is a conflict. Text both sides
 * added must be the same, or one side's with what this rule gives it.
 */
function inherit(outs: Out[], sides: Sides): {outs: Out[]; inherited: boolean} {
  let inherited = false;
  /** `token` of side `x`, with what the other side gave both neighbours; null when nothing changes. */
  const made = (
    token: Token,
    x: 1 | 2,
    left: Out | null,
    right: Out | null,
  ): {attrs: Props; path: readonly Wrap[]; pathKey: string} | null => {
    const s = x === 1 ? 2 : 1;
    const around = [left, right].flatMap(out =>
      out === null || out.origin !== 0
        ? []
        : [
            {
              b: sides[0][out.at[0]],
              s: sides[s][out.at[s]],
              x: sides[x][out.at[x]],
            },
          ],
    );
    const [l, r] = around.length === 2 ? around : [null, null];
    // The link or mark: where both neighbours went into the same one.
    let path = token.path;
    let pathKey = token.pathKey;
    if (
      l !== null &&
      r !== null &&
      l.s.pathKey !== l.b.pathKey &&
      r.s.pathKey !== r.b.pathKey &&
      sameWraps(l.s.path, r.s.path)
    ) {
      if (token.pathKey !== l.x.pathKey && token.pathKey !== r.x.pathKey) {
        fail(
          'format',
          'one side added a link or mark inside text the other side put in another',
        );
      }
      path = l.s.path;
      pathKey = l.s.pathKey;
    } else {
      for (const q of around) {
        if (
          q.s.pathKey !== q.b.pathKey &&
          token.path.length > 0 &&
          token.pathKey === q.x.pathKey
        ) {
          fail(
            'format',
            'one side added text at the edge of a link or mark the other side changed',
          );
        }
      }
    }
    // Each property, each format bit and each NodeState key both
    // neighbours changed alike.
    const attrs =
      l !== null && r !== null && !token.opaque
        ? inheritProps(token.attrs, l, r)
        : token.attrs;
    return attrs === token.attrs && pathKey === token.pathKey
      ? null
      : {attrs, path, pathKey};
  };
  for (let start = 0; start < outs.length; ) {
    const origin = outs[start].origin;
    let end = start + 1;
    while (origin !== 0 && end < outs.length && outs[end].origin === origin) {
      end++;
    }
    const left = start > 0 ? outs[start - 1] : null;
    const right = end < outs.length ? outs[end] : null;
    for (let i = start; origin !== 0 && i < end; i++) {
      const out = outs[i];
      if (origin === 3) {
        const ty = sides[1][out.at[1]];
        const tn = sides[2][out.at[2]];
        if (ty.attrsKey === tn.attrsKey && ty.pathKey === tn.pathKey) {
          continue;
        }
        const becomes = (from: Token, x: 1 | 2, target: Token) => {
          try {
            const result = made(from, x, left, right);
            return (
              result !== null &&
              result.pathKey === target.pathKey &&
              canonical(result.attrs) === target.attrsKey
            );
          } catch (error) {
            if (error instanceof Conflict) {
              return false;
            }
            throw error;
          }
        };
        const take = becomes(ty, 1, tn) ? tn : becomes(tn, 2, ty) ? ty : null;
        if (take === null) {
          fail(
            'overlap',
            'both sides added the same text at one place, formatted differently',
          );
        }
        Object.assign(out, {
          attrs: take.attrs,
          attrsKey: take.attrsKey,
          path: take.path,
          pathKey: take.pathKey,
        });
      } else {
        const result = made(sides[origin][out.at[origin]], origin, left, right);
        if (result !== null) {
          inherited = true;
          Object.assign(out, {
            attrs: result.attrs,
            attrsKey: canonical(result.attrs),
            path: result.path,
            pathKey: result.pathKey,
          });
        }
      }
    }
    start = end;
  }
  return {inherited, outs};
}

// ---------------------------------------------------------------------------
// Blocks

/** Whether `children` of `node` hold text (inline nodes), blocks, or nothing. */
function contentOf(
  node: Json,
  kinds: NodeKinds,
): 'text' | 'blocks' | 'empty' | 'leaf' {
  const kind = kinds.get(node.type);
  if (kind === 'block-leaf') {
    return 'leaf';
  }
  const children = childrenOf(node);
  if (kind !== 'block-element' || children === null) {
    return fail(
      'unsupported',
      kind === undefined || kind === 'mixed'
        ? `a node type the merge does not know (${node.type})`
        : `a ${node.type} where a block is expected`,
    );
  }
  let blocks = 0;
  for (const child of children) {
    const childKind = kinds.get(child.type);
    if (childKind === 'block-element' || childKind === 'block-leaf') {
      blocks++;
    } else if (childKind === undefined || childKind === 'mixed') {
      fail(
        'unsupported',
        `a node type the merge does not know (${child.type})`,
      );
    }
  }
  if (children.length === 0) {
    return 'empty';
  }
  if (blocks !== 0 && blocks !== children.length) {
    fail('unsupported', `a ${node.type} that holds text beside blocks`);
  }
  return blocks === 0 ? 'text' : 'blocks';
}

/** A text block's children merged, with every check (see the file header). */
function mergeText(
  b: readonly Json[],
  y: readonly Json[],
  n: readonly Json[],
  kinds: NodeKinds,
): Json[] {
  const sides: Sides = [
    tokenize(b, kinds),
    tokenize(y, kinds),
    tokenize(n, kinds),
  ];
  // What was read is what would be written: a document whose children do
  // not come back from their own tokens holds a shape tokens cannot carry.
  const inputs = [b, y, n];
  for (let z = 0; z < 3; z++) {
    if (sides[z].length > BLOCK_MERGE_MAX_TOKENS) {
      fail(
        'unsupported',
        `a block of more than ${BLOCK_MERGE_MAX_TOKENS} characters`,
      );
    }
    const alone: [Token[], Token[], Token[]] = [[], [], []];
    alone[z] = sides[z] as Token[];
    if (
      canonical(build(asOuts(sides[z], z as 0 | 1 | 2), alone)) !==
      canonical(inputs[z])
    ) {
      fail('unsupported', 'text nodes the merge does not read back as stored');
    }
  }
  const {inherited, outs} = mergeTokens(sides);
  const merged = build(outs, sides);
  const key = canonical(merged);
  const again = (other: Sides): string | null => {
    try {
      return canonical(build(mergeTokens(other).outs, other));
    } catch (error) {
      if (error instanceof Conflict) {
        return null;
      }
      throw error;
    }
  };
  // 1. Every reading makes the same block: by word and by character, each
  //    from the start and from the end. An edit that could sit at more than
  //    one place among equal text (a word typed beside the same word) is
  //    aligned at its first place one way and its last the other, and a
  //    word an edit joined to its neighbour (`quietly` to `quietlybold`)
  //    can pair with an equal word elsewhere by word but not by character:
  //    nothing in the result may hang on which.
  const lengths = sides.map(side => side.length);
  const reversed = sides.map(side => [...side].reverse()) as unknown as Sides;
  for (const [byWord, backwards] of [
    [true, true],
    [false, false],
    [false, true],
  ] as const) {
    let made: string | null = null;
    try {
      const read = mergeTokens(backwards ? reversed : sides, byWord).outs;
      made = canonical(
        build(
          backwards
            ? read.reverse().map(out => ({
                ...out,
                at: out.at.map((i, z) =>
                  i < 0 ? -1 : lengths[z] - 1 - i,
                ) as unknown as Out['at'],
              }))
            : read,
          sides,
        ),
      );
    } catch (error) {
      if (!(error instanceof Conflict)) {
        throw error;
      }
    }
    if (made !== key) {
      fail('unverified', 'the merge depends on how the text is aligned');
    }
  }
  // 2. Merging either side into the result changes nothing: it holds each
  //    side's changes once. (The describe after a replay is this merge of
  //    yours: it must find the document holds the user's edits.)
  const tokens = tokenize(merged, kinds);
  const againKey = again([sides[0], sides[1], tokens]);
  if (againKey !== key) {
    fail('unverified', "the merge does not hold the user's changes once");
  }
  if (!inherited && again([sides[0], tokens, sides[2]]) !== key) {
    fail('unverified', "the merge does not hold the document's changes once");
  }
  return merged;
}

/** Three blocks that are one block (by id, or by place in a container), merged. */
function mergeNode(b: Json, y: Json, n: Json, kinds: NodeKinds): Json {
  const kb = canonical(b);
  const ky = canonical(y);
  const kn = canonical(n);
  if (ky === kb || ky === kn) {
    return n;
  }
  if (kn === kb) {
    return y;
  }
  const contents = [
    contentOf(b, kinds),
    contentOf(y, kinds),
    contentOf(n, kinds),
  ];
  if (contents.includes('leaf')) {
    return fail('overlap', `both sides changed one ${b.type}`);
  }
  if (contents.every(content => content !== 'blocks')) {
    const props = mergeElementProps(b, y, n);
    const cb = childrenOf(b) || [];
    const cy = childrenOf(y) || [];
    const cn = childrenOf(n) || [];
    const sb = canonical(cb);
    const sy = canonical(cy);
    const sn = canonical(cn);
    const children =
      sy === sb || sy === sn
        ? cn
        : sn === sb
          ? cy
          : mergeText(cb, cy, cn, kinds);
    return {...props, children} as unknown as Json;
  }
  if (contents.every(content => content !== 'text')) {
    return mergeContainer(b, y, n, kinds);
  }
  return fail(
    'structure',
    `the ${b.type} holds text on one side and blocks on another`,
  );
}

/**
 * A block under a container as diff3 compares it: by its id; a wrapper
 * without one (a table row, a cell) by the first block with an id inside
 * it; anything else by its whole JSON (any change replaces it).
 */
function keyOf(node: Json, kinds: NodeKinds): string {
  const id = blockIdOf(node);
  if (id !== null) {
    return `i${id}`;
  }
  if (contentOf(node, kinds) === 'blocks') {
    for (const child of childrenOf(node) || []) {
      const inner = keyOf(child, kinds);
      if (inner[0] !== 'v') {
        return `w${node.type}\u0000${inner}`;
      }
    }
  }
  return `v${canonical(node)}`;
}

/** Two blocks both sides made the same (by key), each against its base block when it has one. */
function mergeAlike(
  mine: Json,
  theirs: Json,
  baseByKey: ReadonlyMap<string, Json>,
  kinds: NodeKinds,
): Json {
  if (canonical(mine) === canonical(theirs)) {
    return theirs;
  }
  const was = baseByKey.get(keyOf(mine, kinds));
  if (was !== undefined) {
    return mergeNode(was, mine, theirs, kinds);
  }
  return fail(
    'structure',
    `both sides added a ${mine.type} at one place, differently`,
  );
}

/**
 * A container's children merged with diff3 over their keys (keyOf): a
 * child both sides kept is merged (mergeNode), children one side added,
 * removed or moved are taken from that side, and two changes to which
 * children there are at one place are a conflict unless they are the same.
 */
function mergeContainer(b: Json, y: Json, n: Json, kinds: NodeKinds): Json {
  const props = mergeElementProps(b, y, n);
  const cb = childrenOf(b) || [];
  const cy = childrenOf(y) || [];
  const cn = childrenOf(n) || [];
  const kb = cb.map(child => keyOf(child, kinds));
  const ky = cy.map(child => keyOf(child, kinds));
  const kn = cn.map(child => keyOf(child, kinds));
  for (const keys of [kb, ky, kn]) {
    if (new Set(keys).size !== keys.length) {
      fail('unsupported', `a ${b.type} that holds one block twice`);
    }
  }
  const {found, hunks} = align3(ky, kb, kn);
  const toYours = unitMap(kb.length, hunks[0]);
  const toNow = unitMap(kb.length, hunks[1]);
  // A block one side removed (or moved), the other changed.
  cb.forEach((child, j) => {
    const yi = toYours[j];
    const ni = toNow[j];
    if (
      (yi < 0 && ni >= 0 && canonical(cn[ni]) !== canonical(child)) ||
      (ni < 0 && yi >= 0 && canonical(cy[yi]) !== canonical(child))
    ) {
      fail(
        'structure',
        `one side removed a ${child.type} and the other changed it`,
      );
    }
  });
  const baseByKey = new Map(kb.map((key, j) => [key, cb[j]]));
  const children: Json[] = [];
  for (const region of found) {
    if (region.stable && region.buffer === 'o') {
      for (
        let j = region.bufferStart;
        j < region.bufferStart + region.bufferLength;
        j++
      ) {
        children.push(mergeNode(cb[j], cy[toYours[j]], cn[toNow[j]], kinds));
      }
    } else if (region.stable) {
      const from = region.buffer === 'a' ? cy : cn;
      for (
        let i = region.bufferStart;
        i < region.bufferStart + region.bufferLength;
        i++
      ) {
        children.push(from[i]);
      }
    } else {
      if (
        region.aLength !== region.bLength ||
        region.aContent.some((key, k) => key !== region.bContent[k])
      ) {
        fail(
          'structure',
          `both sides changed which blocks the ${b.type} holds, differently`,
        );
      }
      for (let k = 0; k < region.aLength; k++) {
        children.push(
          mergeAlike(
            cy[region.aStart + k],
            cn[region.bStart + k],
            baseByKey,
            kinds,
          ),
        );
      }
    }
  }
  return {...props, children} as unknown as Json;
}

/** Every block id under `node`, itself included; throws on a repeat. */
function collectIds(node: unknown, ids: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectIds(item, ids);
    }
  } else if (isObject(node)) {
    if (typeof node.type === 'string') {
      const id = blockIdOf(node as unknown as Json);
      if (id !== null) {
        if (ids.has(id)) {
          fail('unverified', `the merge holds the block id ${id} twice`);
        }
        ids.add(id);
      }
    }
    collectIds(node.children, ids);
  }
}

/** What {@link mergeBlock} returns. */
export type BlockMergeResult =
  | {readonly ok: true; readonly merged: SerializedLexicalNode}
  | {
      readonly ok: false;
      readonly conflict: YUnsyncedConflict;
      readonly detail: string;
    };

/**
 * One block merged three ways: `yours` and `now`, both changed from
 * `base`, into the block that holds both sides' changes, or the conflict
 * that keeps it from being made. `kinds` says what each node type is in
 * the editor that read the three.
 */
export function mergeBlock(
  base: SerializedLexicalNode,
  yours: SerializedLexicalNode,
  now: SerializedLexicalNode,
  kinds: NodeKinds,
): BlockMergeResult {
  try {
    const merged = mergeNode(base, yours, now, kinds);
    const id = blockIdOf(base);
    if (id === null || blockIdOf(merged) !== id) {
      fail('unverified', 'the merge changed the block id');
    }
    collectIds(merged, new Set());
    // The user's block merged into the result is the result: it holds
    // their changes, once. This is also what the report made after a
    // replay computes, and it must find the document holds the user's
    // edits, or the block would stay in the panel for good.
    let again: Json | null = null;
    try {
      again = mergeNode(base, yours, merged, kinds);
    } catch (error) {
      if (!(error instanceof Conflict)) {
        throw error;
      }
    }
    if (again === null || canonical(again) !== canonical(merged)) {
      fail('unverified', "the merge does not hold the user's changes once");
    }
    return {merged, ok: true};
  } catch (error) {
    if (error instanceof Conflict) {
      return {conflict: error.conflict, detail: error.detail, ok: false};
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The report's blocks

/** `blocks` by id, or null when any block lacks one. */
function byId(blocks: readonly Json[]): Map<string, Json> | null {
  const map = new Map<string, Json>();
  for (const block of blocks) {
    const id = blockIdOf(block);
    if (id === null || map.has(id)) {
      return null;
    }
    map.set(id, block);
  }
  return map;
}

const sameJSON = (a: Json | null | undefined, b: Json | null | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The blocks of describeUnsyncedEdits' report, from the top-level blocks
 * of the three documents: what the user changed, with what a replay does
 * with each (see YUnsyncedBlock).
 */
export function describeBlocks(input: {
  readonly yours: readonly SerializedLexicalNode[];
  readonly base: readonly SerializedLexicalNode[] | null;
  readonly now: readonly SerializedLexicalNode[];
  /** Null: nothing is known of the node types, so nothing is merged. */
  readonly kinds: NodeKinds | null;
  readonly blockMerge: boolean;
}): YUnsyncedBlock[] {
  const {base, blockMerge, kinds, now, yours} = input;
  const against = base ?? now;
  const blocks: YUnsyncedBlock[] = [];
  const yoursById = byId(yours);
  const againstById = byId(against);
  const nowById = byId(now);
  if (yoursById !== null && againstById !== null && nowById !== null) {
    const entry = (
      id: string,
      change: YUnsyncedBlock['change'],
      block: Json | null,
      was: Json | null,
    ): YUnsyncedBlock => {
      const current = nowById.get(id) ?? null;
      const common = {
        base: base === null ? null : was,
        change,
        id,
        now: current,
        yours: block,
      };
      if (base !== null && sameJSON(current, was)) {
        return {...common, merged: null, replayable: true, resolution: 'whole'};
      }
      const conflict = (
        reason: YUnsyncedConflict,
        conflictDetail: string,
      ): YUnsyncedBlock => ({
        ...common,
        conflict: reason,
        conflictDetail,
        merged: null,
        replayable: false,
        resolution: 'conflict',
      });
      if (base === null) {
        return conflict(
          'no-base',
          'the document the edits were made against is gone',
        );
      }
      if (canonical(block) === canonical(current)) {
        // The same change on both sides: the document holds the user's.
        return {
          ...common,
          merged: current,
          replayable: false,
          resolution: 'merged',
        };
      }
      if (block === null || was === null || current === null) {
        return conflict(
          'added-or-deleted',
          block === null
            ? 'the user deleted a block that was changed since'
            : current === null
              ? 'the user changed a block that was deleted since'
              : 'both sides added a block with this id',
        );
      }
      if (!blockMerge || kinds === null) {
        return conflict(
          'block-merge-off',
          'both sides changed the block, and blockMerge is off',
        );
      }
      const result = mergeBlock(was, block, current, kinds);
      return result.ok
        ? {
            ...common,
            merged: result.merged,
            replayable: false,
            resolution: 'merged',
          }
        : conflict(result.conflict, result.detail);
    };
    for (const [id, block] of yoursById) {
      const was = againstById.get(id) ?? null;
      if (was === null || !sameJSON(was, block)) {
        blocks.push(entry(id, was === null ? 'added' : 'changed', block, was));
      }
    }
    for (const [id, was] of againstById) {
      if (!yoursById.has(id)) {
        blocks.push(entry(id, 'deleted', null, was));
      }
    }
  } else {
    // Without ids: by position.
    const length = Math.max(yours.length, against.length);
    for (let i = 0; i < length; i++) {
      const block = yours[i] ?? null;
      const was = against[i] ?? null;
      if (!sameJSON(block, was)) {
        blocks.push({
          base: base === null ? null : was,
          change:
            was === null ? 'added' : block === null ? 'deleted' : 'changed',
          conflict: base === null ? 'no-base' : 'no-block-ids',
          conflictDetail:
            base === null
              ? 'the document the edits were made against is gone'
              : 'the blocks have no ids (BlockIdExtension), so they are matched by position',
          id: `#${i}`,
          merged: null,
          now: now[i] ?? null,
          replayable: false,
          resolution: 'conflict',
          yours: block,
        });
      }
    }
  }
  return blocks;
}
