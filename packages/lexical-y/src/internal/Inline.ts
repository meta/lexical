/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Hidden} from './Hidden';
import type {Item} from '@y/y';

import {ContentFormat, ContentString, ContentType} from '@y/y';
import {
  $isLineBreakNode,
  $isTextNode,
  type ElementNode,
  type LexicalNode,
  type NodeKey,
  type TextNode,
} from 'lexical';

import {type Formats, isLiveContent} from './Cursor';
import {
  $foreignFlatKeys,
  $isWrapper,
  $lineBreakAttrs,
  $textAttrs,
  $wrapperAttrs,
  type Attrs,
  decodeFormatValue,
  isMergeableText,
  MARKER,
  RUN_END,
  SEGMENT_KEY,
  stableStringify,
  TYPE_KEY,
  WRAPPER_PREFIX,
} from './Schema';
import {isGone, unheldLength} from './Seen';

// Inline content as atoms, the form both the editor's side ($pushInline)
// and the shared side (readAtoms) are compared in: one atom per content unit
// of the shared sequence (a character, or a child node), with runs of equal
// attributes. The writer diffs two atom sequences (see diffAtoms), whole
// words where text is replaced (see snapToWords).
//
// Invariant: the atoms of what the editor holds equal the atoms a reader
// reads from what is stored, or the author reads its content again (see
// DesiredContext.flattened). Why: the author shows what every reader shows.
//
// A sequence of atoms: `text` holds one UTF-16 unit per atom, with OBJ in
// place of every child node; `specials` describes those.

const OBJ = '\ufffc';

type Special =
  | {readonly kind: 'inline'; readonly key: NodeKey; readonly node: LexicalNode}
  | {readonly kind: 'marker'; readonly ref: unknown}
  | {readonly kind: 'runEnd'; readonly ref: unknown}
  | {readonly kind: 'oldNode'; readonly item: Item; readonly name: string};

export type Run = {start: number; end: number; attrs: Attrs};

export class Atoms {
  text = '';
  specials = new Map<number, Special>();
  runs: Run[] = [];
  /** The old items of marker / run-end atoms (old atoms only). */
  items = new Map<number, Item>();
  /**
   * Where each text range comes from (desired atoms only): the text node it
   * was in before this update. The diff keeps an old character only for the
   * same origin, so text that moved between nodes or lines is never built
   * from old characters that happen to be equal.
   */
  origins: [number, number, string][] = [];
  /**
   * The text nodes the text comes from, with their ranges (desired atoms
   * with origins only): what Writer#$sameTextLineage checks.
   */
  textNodes: [number, number, NodeKey][] = [];
  /**
   * The line breaks and inline nodes, with their atoms (desired atoms with
   * origins only): see Writer#$exactAtoms.
   */
  nodes: [number, NodeKey][] = [];
  pushText(s: string, attrs: Attrs): void {
    if (s.length === 0) {
      return;
    }
    const start = this.text.length;
    this.text += s;
    this.pushRun(start, this.text.length, attrs);
  }
  pushSpecial(special: Special, attrs: Attrs | null, item?: Item): void {
    const at = this.text.length;
    this.text += OBJ;
    this.specials.set(at, special);
    if (item !== undefined) {
      this.items.set(at, item);
    }
    if (attrs !== null) {
      this.pushRun(at, at + 1, attrs);
    }
  }
  private pushRun(start: number, end: number, attrs: Attrs): void {
    const last = this.runs[this.runs.length - 1];
    if (last !== undefined && last.end === start && last.attrs === attrs) {
      last.end = end;
    } else {
      this.runs.push({attrs, end, start});
    }
  }
  get length(): number {
    return this.text.length;
  }
}

// ---------------------------------------------------------------------------
// Desired atoms from Lexical

type SegmentKeys = {
  get(key: NodeKey): string | undefined;
  /** A new segment key, or null where none may be made (see $checkWrite). */
  create(key: NodeKey): string | null;
};

export type DesiredContext = {
  segments: SegmentKeys;
  /** Selection point to bias the diff with: node key and offset. */
  cursor: {key: NodeKey; offset: number; type: 'text' | 'element'} | null;
  /** Atom offset of the cursor, filled in when reached. */
  cursorAt: number;
  /** Origin ranges of a text node's text (relative), see Atoms.origins. */
  originOf?: ((node: TextNode) => [number, number, string][]) | null;
  /**
   * Set when the content is stored, and read, otherwise than the editor
   * holds it: a wrapper nested in a wrapper of its own type (a link in a
   * link), as the formats store one per type, the inner one; two adjacent
   * text nodes that store the same attributes (that Lexical did not merge,
   * because of NodeState it compares by reference), as one text node. The
   * author then reads the content again, to show what every reader shows.
   */
  flattened?: boolean;
};

/**
 * Stands for a line break the normalization inserts and the editor does not
 * hold yet, in the inline content of a part of a line that holds lines (see
 * Writer#$pushLine): written as the `\n` a fresh LineBreakNode is.
 */
export const PENDING_LINE_BREAK: LexicalNode = {
  pendingLineBreak: true,
} as unknown as LexicalNode;

/**
 * Push the inline content `nodes` (children of a line, a run, or an inline
 * container): text, line breaks, wrappers flattened into formats, every other
 * node as one inline child.
 */
export function $pushInline(
  out: Atoms,
  nodes: readonly LexicalNode[],
  ctx: DesiredContext,
  wrapperAttrs: Attrs = {},
): void {
  // The stored attributes of the text node before, when it has no segment
  // key (see DesiredContext.flattened).
  let prevText: string | null = null;
  for (const node of nodes) {
    const afterText: string | null = prevText;
    prevText = null;
    if (node === PENDING_LINE_BREAK) {
      out.pushText('\n', {...wrapperAttrs});
    } else if ($isTextNode(node)) {
      const text = node.getTextContent();
      const segment = isMergeableText(node)
        ? null
        : (ctx.segments.get(node.getKey()) ??
          ctx.segments.create(node.getKey()));
      const attrs = {...wrapperAttrs, ...$textAttrs(node, segment)};
      // (Not around the node being composed: Lexical holds its merges back
      // until the composition ends, see DEFER_COMPOSITION_MERGE_TAG.)
      if (segment === null && text !== '' && !node.isComposing()) {
        prevText = stableStringify(attrs);
        if (prevText === afterText) {
          ctx.flattened = true;
        }
      }
      // A node whose NodeState JSON a reader lays out otherwise (see
      // $foreignFlatKeys): the author reads it back too.
      if ($foreignFlatKeys(node) !== null) {
        ctx.flattened = true;
      }
      if (
        ctx.cursor !== null &&
        ctx.cursor.type === 'text' &&
        ctx.cursor.key === node.getKey()
      ) {
        ctx.cursorAt = out.length + ctx.cursor.offset;
      }
      if (ctx.originOf) {
        for (const [a, b, k] of ctx.originOf(node)) {
          out.origins.push([out.length + a, out.length + b, k]);
        }
        if (text.length > 0) {
          out.textNodes.push([
            out.length,
            out.length + text.length,
            node.getKey(),
          ]);
        }
      }
      out.pushText(text, attrs);
    } else if ($isLineBreakNode(node)) {
      if (ctx.originOf) {
        out.nodes.push([out.length, node.getKey()]);
      }
      out.pushText('\n', $lineBreakAttrs(node, wrapperAttrs));
    } else if ($isWrapper(node)) {
      if (WRAPPER_PREFIX + node.getType() in wrapperAttrs) {
        ctx.flattened = true;
      }
      const attrs = {...wrapperAttrs};
      // An instance key tells this wrapper apart from an equal one right
      // before it (kept once given, so the value stays stable).
      let instance = ctx.segments.get(node.getKey()) ?? null;
      const prev = node.getPreviousSibling();
      if (
        instance === null &&
        prev !== null &&
        $isWrapper(prev) &&
        prev.getType() === node.getType()
      ) {
        const a: Attrs = {};
        const b: Attrs = {};
        $wrapperAttrs(prev as ElementNode, a);
        $wrapperAttrs(node as ElementNode, b);
        if (stableStringify(a) === stableStringify(b)) {
          instance = ctx.segments.create(node.getKey());
        }
      }
      $wrapperAttrs(node as ElementNode, attrs, instance);
      $pushInline(out, (node as ElementNode).getChildren(), ctx, attrs);
    } else {
      if (ctx.originOf) {
        out.nodes.push([out.length, node.getKey()]);
      }
      out.pushSpecial({key: node.getKey(), kind: 'inline', node}, wrapperAttrs);
    }
  }
}

// ---------------------------------------------------------------------------
// Old atoms from Yjs

/**
 * Atoms of the shared items from `start` (inclusive) up to `stop`
 * (exclusive, null = end), with the formats in effect at `start`, as the
 * editor shows them: without what is held back (see Hidden). Returns the
 * formats stored at `stop`, held-back ones too (where a write cursor starts,
 * see Cursor).
 */
export function readAtoms(
  start: Item | null,
  stop: Item | null,
  formats: Formats,
  out: Atoms,
  hidden: Hidden | null = null,
): Formats {
  const current = new Map(formats);
  // The formats the editor shows: `current` without held-back ones.
  const shown = hidden === null ? current : new Map(formats);
  let attrs: Attrs | null = null;
  for (let it = start; it !== null && it !== stop; it = it.right) {
    if (isGone(it)) {
      continue;
    }
    const content = it.content;
    if (content instanceof ContentFormat) {
      applyFormat(current, content);
      if (shown !== current && !hidden!.hides(it)) {
        applyFormat(shown, content);
      }
      attrs = null;
      continue;
    }
    if (!it.countable) {
      continue;
    }
    if (attrs === null) {
      attrs = Object.fromEntries(shown);
    }
    if (hidden !== null) {
      const runs = hidden.runs(it);
      if (runs.length > 1 || runs[0][1]) {
        // Partly or wholly held back: only shown text counts (a held node
        // or marker is not there).
        if (content instanceof ContentString) {
          let pos = 0;
          for (const [len, isHidden] of runs) {
            if (!isHidden) {
              pushStoredText(out, content.str.slice(pos, pos + len), attrs);
            }
            pos += len;
          }
        }
        continue;
      }
    }
    if (content instanceof ContentString) {
      pushStoredText(out, content.str, attrs);
    } else if (content instanceof ContentType) {
      const name = content.type.name as string;
      if (name === MARKER) {
        out.pushSpecial({kind: 'marker', ref: it}, attrs, it);
      } else if (name === RUN_END) {
        out.pushSpecial({kind: 'runEnd', ref: it}, attrs, it);
      } else {
        out.pushSpecial({item: it, kind: 'oldNode', name}, attrs, it);
      }
    } else {
      // Embeds and other content this binding does not write: kept as
      // opaque atoms (never equal to anything we write).
      for (let i = 0; i < it.length; i++) {
        out.pushSpecial({item: it, kind: 'oldNode', name: ''}, attrs, it);
      }
    }
  }
  return current;
}

function applyFormat(formats: Formats, content: ContentFormat): void {
  if (content.value === null) {
    formats.delete(content.key);
  } else {
    formats.set(content.key, content.value);
  }
}

/**
 * Stored text under its formats, as the reader shows it: a node type key
 * (`t`, with the segment key `k`) applies to the characters that type
 * stores only, a tab's `"\t"`; other text under it (a tab's opener left
 * open by a delete that bypassed the writer) is plain text. So the writer
 * does not close and reopen such an opener around text it writes, and the
 * self-check compares what the reader shows.
 */
function pushStoredText(out: Atoms, text: string, attrs: Attrs): void {
  if (
    attrs[TYPE_KEY] === undefined ||
    decodeFormatValue(attrs[TYPE_KEY]) !== 'tab' ||
    /^\t+$/.test(text)
  ) {
    out.pushText(text, attrs);
    return;
  }
  const plain: Attrs = {...attrs};
  delete plain[TYPE_KEY];
  delete plain[SEGMENT_KEY];
  for (const run of text.match(/\t+|[^\t]+/g) || []) {
    out.pushText(run, run[0] === '\t' ? attrs : plain);
  }
}

/** Live content items from `start` up to `stop` (exclusive). */
export function countLive(
  start: Item | null,
  stop: Item | null,
  hidden: Hidden | null = null,
): number {
  let n = 0;
  for (let it = start; it !== null && it !== stop; it = it.right) {
    if (isLiveContent(it)) {
      n += unheldLength(it, hidden);
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Diff

type AtomMatch = (oldAt: number, newAt: number) => boolean;

/**
 * Common prefix and suffix of two atom sequences, with the prefix limited
 * by the cursor (so typing a character equal to its neighbour lands where
 * the cursor is).
 */
export function diffAtoms(
  a: Atoms,
  b: Atoms,
  match: AtomMatch,
  cursor: number,
): {prefix: number; suffix: number} {
  const at = a.text;
  const bt = b.text;
  const max = Math.min(at.length, bt.length);
  const eq = (i: number, j: number) => {
    const c = at.charCodeAt(i);
    if (c !== bt.charCodeAt(j)) {
      return false;
    }
    if (c !== 0xfffc) {
      return !a.specials.has(i) && !b.specials.has(j);
    }
    const sa = a.specials.has(i);
    const sb = b.specials.has(j);
    if (!sa && !sb) {
      return true;
    }
    return sa && sb && match(i, j);
  };
  // Equal chunks without child nodes are skipped with native string
  // comparisons, so the cost of a small change in a long line is not a
  // JavaScript loop over every character.
  const CHUNK = 256;
  const forward = (from: number, to: number): number => {
    let i = from;
    while (i + CHUNK <= to) {
      const chunk = at.substring(i, i + CHUNK);
      if (chunk !== bt.substring(i, i + CHUNK) || chunk.includes(OBJ)) {
        break;
      }
      i += CHUNK;
    }
    while (i < to && eq(i, i)) {
      i++;
    }
    return i;
  };
  const backward = (count: number): number => {
    let n = 0;
    while (n + CHUNK <= count) {
      const chunk = at.substring(at.length - n - CHUNK, at.length - n);
      if (
        chunk !== bt.substring(bt.length - n - CHUNK, bt.length - n) ||
        chunk.includes(OBJ)
      ) {
        break;
      }
      n += CHUNK;
    }
    while (n < count && eq(at.length - 1 - n, bt.length - 1 - n)) {
      n++;
    }
    return n;
  };
  // Prefix up to the cursor first, then the suffix, then the rest of the
  // prefix (as simpleDiffWithCursor does).
  // The cursor is after inserted text (and at the start of deleted text).
  // That holds only while the text after the cursor is unchanged: after a
  // join or a paste the cursor sits before the new text, and a plain
  // prefix-first diff keeps the old line's end where it was.
  const delta = bt.length - at.length;
  const limit =
    cursor >= 0 &&
    cursor <= bt.length &&
    cursor - delta >= 0 &&
    bt.substring(cursor) === at.substring(cursor - delta)
      ? Math.max(0, Math.min(cursor - Math.max(0, delta), max))
      : max;
  let prefix = forward(0, limit);
  let suffix = backward(max - prefix);
  prefix = forward(prefix, max - suffix);
  // Never split a surrogate pair (a diff inside one would write half a
  // character).
  if (prefix > 0 && isHighSurrogate(at.charCodeAt(prefix - 1))) {
    prefix--;
  }
  if (suffix > 0 && isLowSurrogate(at.charCodeAt(at.length - suffix))) {
    suffix--;
  }
  return {prefix, suffix};
}

/**
 * Whether the caret at `cursor` of `b` places an edit that makes `b` of `a`
 * (see diffStrings): the text after it is unchanged.
 */
function caretAnchors(a: string, b: string, cursor: number): boolean {
  const delta = b.length - a.length;
  return (
    cursor >= 0 &&
    cursor <= b.length &&
    cursor - delta >= 0 &&
    b.substring(cursor) === a.substring(cursor - delta)
  );
}

/** Common prefix and suffix of two strings, the prefix limited by a cursor. */
export function diffStrings(
  a: string,
  b: string,
  cursor: number,
): {prefix: number; suffix: number} {
  const max = Math.min(a.length, b.length);
  const CHUNK = 256;
  const forward = (from: number, to: number) => {
    let i = from;
    while (
      i + CHUNK <= to &&
      a.substring(i, i + CHUNK) === b.substring(i, i + CHUNK)
    ) {
      i += CHUNK;
    }
    while (i < to && a.charCodeAt(i) === b.charCodeAt(i)) {
      i++;
    }
    return i;
  };
  // The caret is after inserted text and at the start of deleted text:
  // with a run of equal characters (a space typed next to a space), place
  // the change before the caret, where the user made it.
  // That holds only while the text after the caret is unchanged.
  const delta = b.length - a.length;
  const limit = caretAnchors(a, b, cursor)
    ? Math.max(0, Math.min(cursor - Math.max(0, delta), max))
    : max;
  let prefix = forward(0, limit);
  let suffix = 0;
  const count = max - prefix;
  while (
    suffix + CHUNK <= count &&
    a.substring(a.length - suffix - CHUNK, a.length - suffix) ===
      b.substring(b.length - suffix - CHUNK, b.length - suffix)
  ) {
    suffix += CHUNK;
  }
  while (
    suffix < count &&
    a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)
  ) {
    suffix++;
  }
  prefix = forward(prefix, max - suffix);
  // Never split a surrogate pair.
  if (prefix > 0 && isHighSurrogate(a.charCodeAt(prefix - 1))) {
    prefix--;
  }
  if (suffix > 0 && isLowSurrogate(a.charCodeAt(a.length - suffix))) {
    suffix--;
  }
  return {prefix, suffix};
}

const SPACE = /\s/;
// Scripts written without spaces between words: each character is a word of
// its own here, so a replacement in such text is not widened.
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/**
 * The first code unit of the character (code point) that the code unit at
 * `i` is part of: `i`, or `i - 1` for the second half of a surrogate pair.
 */
const charStart = (s: string, i: number): number =>
  i > 0 &&
  isLowSurrogate(s.charCodeAt(i)) &&
  isHighSurrogate(s.charCodeAt(i - 1))
    ? i - 1
    : i;

/**
 * Whether the character the code unit at `i` is part of is in a word: the
 * whole character is classified (a Han character beyond U+FFFF is a
 * surrogate pair, neither half of which is Han by itself).
 */
const isWordChar = (s: string, i: number): boolean => {
  if (i < 0 || i >= s.length || s.charCodeAt(i) === 0xfffc) {
    return false;
  }
  const start = charStart(s, i);
  const c = String.fromCodePoint(s.codePointAt(start)!);
  return !SPACE.test(c) && !UNSPACED.test(c);
};

const ALNUM = /[\p{L}\p{N}\p{M}]/u;

/**
 * Whether the character the code unit at `i` is part of is a letter, a digit
 * or a combining mark, of a script written with spaces.
 */
const isAlnum = (s: string, i: number): boolean => {
  if (i < 0 || i >= s.length) {
    return false;
  }
  const c = String.fromCodePoint(s.codePointAt(charStart(s, i))!);
  return ALNUM.test(c) && !UNSPACED.test(c);
};

/**
 * Snap a replacement's common prefix and suffix back to word boundaries, so
 * that replaced words are replaced whole. Character-level diffs keep the
 * letters a rewritten line happens to share with the old one (`R` of `Risk`
 * and `Rewritten`, a digit of a number), and a peer's concurrent typing in
 * the replaced text then lands inside the new words.
 *
 * Applies to a replacement (text both removed and inserted): a rewrite, a
 * paste or typing over a selection, an autocorrected word. Two concurrent
 * replacements of one word then both keep their new word whole, instead of
 * each keeping a different part of the old one, which the other deletes.
 * Typing and deleting keep the exact diff, and so does an IME composition
 * (`composing`), which replaces the text being composed on every key.
 * Whitespace, child nodes and every character of a script written without
 * spaces (Han, kana, Thai, ...) are boundaries: the snap never passes a child
 * node or widens into such text, and never splits a surrogate pair.
 */
export function snapToWords(
  a: string,
  b: string,
  prefix: number,
  suffix: number,
  composing = false,
): {prefix: number; suffix: number} {
  const delEnd = a.length - suffix;
  const insEnd = b.length - suffix;
  if (
    delEnd <= prefix ||
    insEnd <= prefix ||
    composing ||
    // A replacement that brings or removes a child node (a paste of
    // formatted content, lines merged around an inline node) is not a word
    // rewrite: its exact diff keeps every character it shares.
    a.slice(prefix, delEnd).includes('\ufffc') ||
    b.slice(prefix, insEnd).includes('\ufffc')
  ) {
    return {prefix, suffix};
  }
  // A word runs across the end of the prefix: drop its kept start, a whole
  // character at a time.
  if (
    isWordChar(a, prefix - 1) &&
    (isWordChar(a, prefix) || isWordChar(b, prefix))
  ) {
    while (isWordChar(a, prefix - 1)) {
      prefix = charStart(a, prefix - 1);
    }
  }
  // A word runs across the start of the suffix: drop its kept end, a whole
  // character at a time.
  if (
    isWordChar(a, a.length - suffix) &&
    (isWordChar(a, a.length - suffix - 1) ||
      isWordChar(b, b.length - suffix - 1))
  ) {
    while (suffix > 0 && isWordChar(a, a.length - suffix)) {
      const at = a.length - suffix;
      suffix -=
        at + 1 < a.length &&
        isHighSurrogate(a.charCodeAt(at)) &&
        isLowSurrogate(a.charCodeAt(at + 1))
          ? 2
          : 1;
    }
  }
  return {prefix, suffix};
}

// More than spaces: a character that is not white space, or a line feed (a
// line break is a node of its own, not a separator).
const NOT_SPACE = /\S|\n/;

/**
 * Where an insertion or a deletion that diffStrings found (`diff` covers the
 * whole shorter text) changes no word, sliding it within the run of equal
 * text it could be in. There if diffStrings put it at such a place (with
 * `first`, both its ends at word edges); else, unless the caret placed it
 * (it stopped the common start), at the first such place with `first`, at
 * the last one without; null where every place is inside a word (between two letters or
 * digits of one, for an insertion; with both ends inside words, for a
 * deletion), or would split a surrogate pair. Without a caret, a diff takes
 * the common start first, so `t1z t2z t3z` made `t1z t3z` deletes `2z t`
 * (and a collaborator's concurrent delete of `t2z` then leaves `t1z 3z`);
 * here it deletes ` t2z` (`first`) or `t2z `.
 */
function placeAtWordEdge(
  a: string,
  b: string,
  diff: {prefix: number; suffix: number},
  first = false,
): {prefix: number; suffix: number} | null {
  const n = Math.min(a.length, b.length);
  // An insertion or a deletion of `m` characters at `k`: of `b` at
  // `[k, k + m)` (an insertion) or of `a` (a deletion).
  const m = Math.abs(b.length - a.length);
  const longer = b.length > a.length ? b : a;
  const splits = (s: string, i: number): boolean =>
    i > 0 &&
    i < s.length &&
    isHighSurrogate(s.charCodeAt(i - 1)) &&
    isLowSurrogate(s.charCodeAt(i));
  // Inside a word: between two letters or digits of one (`t9|z`), not
  // next to punctuation, an emoji or white space, and not in a script
  // written without spaces, where each character is a word.
  const inside = (i: number): boolean => isAlnum(a, i - 1) && isAlnum(a, i);
  const changesNoWord = (k: number): boolean => {
    if (splits(a, k) || splits(longer, k) || splits(longer, k + m)) {
      return false;
    }
    // An insertion inside a word, or a deletion with both ends inside
    // words, changed those words; at a word's edge (`foo` made again as
    // `food`, `fooX.bar`) it is a word's text typed or deleted there.
    return longer === b ? !inside(k) : !(inside(k) && inside(k + m));
  };
  // Moved from where the diff put it, the edit must start and end at word
  // edges of the longer text, so that it neither takes nor gives a piece of
  // a word that stays: `a ba c` made `a c` deletes ` ba`, not `a b` (which
  // would keep the `a` of `ba` as the first word).
  const edge = (i: number): boolean =>
    !(isAlnum(longer, i - 1) && isAlnum(longer, i));
  const moves = (k: number): boolean =>
    changesNoWord(k) && edge(k) && edge(k + m);
  // The places it could be: from the furthest the common end reaches to
  // the furthest the common start reaches (diffStrings takes the common
  // start first unless the caret stops it, at `diff.prefix`).
  const CHUNK = 256;
  let hi = diff.prefix;
  while (
    hi + CHUNK <= n &&
    a.substring(hi, hi + CHUNK) === b.substring(hi, hi + CHUNK)
  ) {
    hi += CHUNK;
  }
  while (hi < n && a.charCodeAt(hi) === b.charCodeAt(hi)) {
    hi++;
  }
  let end = diff.suffix;
  while (
    end + CHUNK <= n &&
    a.substring(a.length - end - CHUNK, a.length - end) ===
      b.substring(b.length - end - CHUNK, b.length - end)
  ) {
    end += CHUNK;
  }
  while (
    end < n &&
    a.charCodeAt(a.length - 1 - end) === b.charCodeAt(b.length - 1 - end)
  ) {
    end++;
  }
  if (first) {
    // Kept where the diff put it unless that takes or gives a piece of a
    // word (see `moves`).
    if (moves(diff.prefix)) {
      return diff;
    }
  } else {
    if (changesNoWord(diff.prefix)) {
      return diff;
    }
    // Where the caret placed it (it stopped the common start), there.
    if (diff.prefix < hi) {
      return null;
    }
  }
  for (
    let k = first ? n - end : hi;
    first ? k <= hi : k >= n - end;
    k += first ? 1 : -1
  ) {
    if (first ? moves(k) : changesNoWord(k)) {
      return {prefix: k, suffix: n - k};
    }
  }
  return null;
}

/**
 * Whether the caret at `cursor` of `b` placed the insertion or deletion that
 * makes `b` of `a`: it anchors the diff (caretAnchors) and its bound is in
 * the run of equal text the edit could be in, the furthest place included.
 * A caret past the furthest place (at the end of the node or past the edit,
 * and the end of the node, which the writer passes for a caret in a later
 * node) anchors every place of the run and places nothing.
 */
function caretPlaces(a: string, b: string, cursor: number): boolean {
  return (
    caretAnchors(a, b, cursor) &&
    cursor - Math.max(0, b.length - a.length) <= diffStrings(a, b, -1).prefix
  );
}

/**
 * The common start and end that text set whole (`setTextContent`, a node's
 * text made again, the DOM's text) keeps of the text it replaces, anchored
 * at `cursor` (see diffStrings): a replacement keeps whole words
 * (snapToWords); an insertion or a deletion keeps every other character,
 * where the caret placed it (caretPlaces), or where the diff put it if both
 * its ends are at word edges, else at the first place in the run of equal
 * text it could be in where they are (placeAtWordEdge), else where the diff
 * put it. The first:
 * a word deleted with the space before it (` t2z` of `t1z t2z t3z`), so
 * text a collaborator types after it at the same time, as typing goes (a
 * space, then a word), keeps the space after it and stays a word of its own.
 */
export function setTextEnds(
  a: string,
  b: string,
  cursor: number,
  composing: boolean,
): {prefix: number; suffix: number} {
  const diff = diffStrings(a, b, cursor);
  if (
    diff.prefix + diff.suffix === Math.min(a.length, b.length) &&
    a.length !== b.length
  ) {
    return composing || caretPlaces(a, b, cursor)
      ? diff
      : (placeAtWordEdge(a, b, diff, true) ?? diff);
  }
  return snapToWords(a, b, diff.prefix, diff.suffix, composing);
}

/**
 * The common start and end that text made in place of removed text (`b`,
 * see TextReplay#stretch) keeps of that text (`a`), as the characters they
 * were: the diff anchored at the caret (diffStrings).
 *
 * An insertion or a deletion keeps every other character, except inside a
 * word: an insertion between two letters or digits of one (`t9z` made again
 * as `t90z`), or a deletion with both ends inside words, changed those
 * words, which are then replaced whole, as by a replacement: a kept piece of
 * the old word would be a piece of the new one, and an edit computed before
 * this one that replaces the old word deletes exactly the old word's
 * characters, so it took that piece out of the new word. At a word's edge
 * (`foo` made again as `food`, `fooX.bar`) every character is kept. Where it
 * could be at several places (`t1z t|9z t2z` or `t1z |t9z t2z`), it goes
 * where the caret placed it, else at the last place inside no word.
 *
 * A replacement keeps whole words (snapToWords). A kept start or end that
 * is only spaces is written with it: a separator alone carries no word, and
 * the old one is the one a concurrent rewrite of the words around it
 * deletes (a node `Note: ` replaced by `Tip: ` while a collaborator rewrites
 * the line kept `Tip:` and lost the space).
 */
export function keptEnds(
  a: string,
  b: string,
  cursor: number,
  composing: boolean,
): {prefix: number; suffix: number} {
  const diff = diffStrings(a, b, cursor);
  const n = Math.min(a.length, b.length);
  if (diff.prefix + diff.suffix === n) {
    if (composing || a.length === b.length) {
      return diff;
    }
    const m = Math.abs(b.length - a.length);
    const longer = b.length > a.length ? b : a;
    const inside = (i: number): boolean => isAlnum(a, i - 1) && isAlnum(a, i);
    const placed = placeAtWordEdge(a, b, diff);
    if (placed !== null) {
      return placed;
    }
    // It changed the word or words it is inside of: those are replaced
    // whole.
    const k = diff.prefix;
    if (longer.slice(k, k + m).includes('\ufffc')) {
      return diff;
    }
    let prefix = k;
    let suffix = n - k;
    if (inside(k)) {
      while (isAlnum(a, prefix - 1)) {
        prefix = charStart(a, prefix - 1);
      }
    }
    if (inside(a.length - suffix)) {
      while (suffix > 0 && isAlnum(a, a.length - suffix)) {
        const at = a.length - suffix;
        suffix -=
          at + 1 < a.length &&
          isHighSurrogate(a.charCodeAt(at)) &&
          isLowSurrogate(a.charCodeAt(at + 1))
            ? 2
            : 1;
      }
    }
    return {
      prefix: NOT_SPACE.test(a.slice(0, prefix)) ? prefix : 0,
      suffix: NOT_SPACE.test(a.slice(a.length - suffix)) ? suffix : 0,
    };
  }
  const {prefix, suffix} = snapToWords(
    a,
    b,
    diff.prefix,
    diff.suffix,
    composing,
  );
  return {
    prefix: NOT_SPACE.test(a.slice(0, prefix)) ? prefix : 0,
    suffix: NOT_SPACE.test(a.slice(a.length - suffix)) ? suffix : 0,
  };
}

/** White space other than a line feed (a line break is a node of its own). */
const isSeparator = (s: string, i: number): boolean =>
  s[i] !== '\n' && SPACE.test(s[i]);

/**
 * The words of `s` from `from` to `to`, as `[start, end)` pairs: runs of
 * word characters (see isWordChar), and single other characters that are not
 * white space (an object character, a line feed, a character of a script
 * written without spaces), each a whole character. White space between them
 * is no word: it is compared only between two kept words.
 */
function words(s: string, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let i = from;
  while (i < to) {
    let j = i + 1;
    if (isWordChar(s, i)) {
      while (j < to && isWordChar(s, j)) {
        j++;
      }
    } else if (j < to && isLowSurrogate(s.charCodeAt(j))) {
      j++;
    }
    if (!isSeparator(s, i)) {
      out.push([i, j]);
    }
    i = j;
  }
  return out;
}

/**
 * The most edits the exact diff of a remade line's words looks for, among
 * the words both texts have (see commonWords). It finds the longest common
 * run of words in O((n + m) * EXACT_EDITS) time at most; past it, only the
 * common start and end are kept. Words only added or only removed between
 * a start and an end the words both texts have share need no search, and
 * count none.
 */
const EXACT_EDITS = 2048;

/**
 * Myers' middle snake of `a[aLo, aHi)` and `b[bLo, bHi)` (both non-empty,
 * different first and last words): `[x, y, u, v]`, relative to `aLo` and
 * `bLo`, a run of equal words from (x, y) to (u, v) on a shortest edit
 * script, or null past `max` edits.
 */
function middleSnake(
  a: readonly number[],
  aLo: number,
  aHi: number,
  b: readonly number[],
  bLo: number,
  bHi: number,
  max: number,
): [number, number, number, number] | null {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const delta = n - m;
  const odd = (delta & 1) !== 0;
  const half = Math.ceil((n + m) / 2);
  const off = half + 1;
  const vf = new Int32Array(2 * half + 3);
  const vb = new Int32Array(2 * half + 3);
  for (let d = 0; d <= half; d++) {
    if (2 * d - 1 > max) {
      return null;
    }
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && vf[off + k - 1] < vf[off + k + 1])
          ? vf[off + k + 1]
          : vf[off + k - 1] + 1;
      let y = x - k;
      const x0 = x;
      const y0 = y;
      while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
        x++;
        y++;
      }
      vf[off + k] = x;
      const c = delta - k;
      if (odd && c >= -(d - 1) && c <= d - 1 && x + vb[off + c] >= n) {
        return [x0, y0, x, y];
      }
    }
    for (let c = -d; c <= d; c += 2) {
      let x =
        c === -d || (c !== d && vb[off + c - 1] < vb[off + c + 1])
          ? vb[off + c + 1]
          : vb[off + c - 1] + 1;
      let y = x - c;
      const x0 = x;
      const y0 = y;
      while (x < n && y < m && a[aHi - 1 - x] === b[bHi - 1 - y]) {
        x++;
        y++;
      }
      vb[off + c] = x;
      const k = delta - c;
      if (!odd && k >= -d && k <= d && x + vf[off + k] >= n) {
        return [n - x, m - y, n - x0, m - y0];
      }
    }
  }
  return null;
}

/**
 * The pairs of a longest common subsequence of `a[aLo, aHi)` and
 * `b[bLo, bHi)`, in order, into `out` (Myers' linear space diff); false
 * past `max` edits.
 */
function exactWords(
  a: readonly number[],
  aLo: number,
  aHi: number,
  b: readonly number[],
  bLo: number,
  bHi: number,
  max: number,
  out: [number, number][],
): boolean {
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
    out.push([aLo++, bLo++]);
  }
  let a1 = aHi;
  let b1 = bHi;
  while (a1 > aLo && b1 > bLo && a[a1 - 1] === b[b1 - 1]) {
    a1--;
    b1--;
  }
  if (aLo < a1 && bLo < b1) {
    const snake = middleSnake(a, aLo, a1, b, bLo, b1, max);
    if (snake === null) {
      return false;
    }
    const [x, y, u, v] = snake;
    exactWords(a, aLo, aLo + x, b, bLo, bLo + y, max, out);
    for (let i = 0; i < u - x; i++) {
      out.push([aLo + x + i, bLo + y + i]);
    }
    exactWords(a, aLo + u, a1, b, bLo + v, b1, max, out);
  }
  for (let i = 0; a1 + i < aHi; i++) {
    out.push([a1 + i, b1 + i]);
  }
  return true;
}

/**
 * The words equal in `a` and `b` that a remade line keeps, as pairs of
 * indexes in increasing order of both: a longest common subsequence of the
 * two (exactWords), found among the words both texts have (a word only one
 * has is never kept, and leaving it out keeps the diff short). Past
 * EXACT_EDITS edits among those, none.
 */
function commonWords(
  a: readonly number[],
  b: readonly number[],
): [number, number][] {
  const inA = new Set(a);
  const inB = new Set(b);
  const fa: number[] = [];
  const fb: number[] = [];
  for (let x = 0; x < a.length; x++) {
    if (inB.has(a[x])) {
      fa.push(x);
    }
  }
  for (let y = 0; y < b.length; y++) {
    if (inA.has(b[y])) {
      fb.push(y);
    }
  }
  const sa = fa.map(x => a[x]);
  const sb = fb.map(y => b[y]);
  const pairs: [number, number][] = [];
  if (!exactWords(sa, 0, sa.length, sb, 0, sb.length, EXACT_EDITS, pairs)) {
    return [];
  }
  return pairs.map(([x, y]) => [fa[x], fb[y]]);
}

/**
 * What text made in place of removed text (`b`, see TextReplay#stretch)
 * keeps of that text (`a`), as ranges `[x0, x1, dx]` of `b` whose character
 * `x` was character `x + dx` of `a`, in order: the common start and end
 * (keptEnds), and between them, where `b` replaced text, every run of whole
 * words that a shortest word-by-word edit script of the rest keeps, with the
 * white space around it that both texts share (`t1z t2z t3z t4z` made again
 * as `t1z n9z t3z n8z` keeps ` t3z `), so that only the changed words are
 * written: a character a collaborator deletes in an unchanged word between
 * two changed ones stays deleted, and a letter it types there stays in that
 * word. White space alone is never kept between two changes, as at the ends.
 */
export function keptStretches(
  a: string,
  b: string,
  cursor: number,
  composing: boolean,
): [number, number, number][] {
  const {prefix, suffix} = keptEnds(a, b, cursor, composing);
  return withKeptWords(a, b, prefix, suffix, composing);
}

/**
 * What text set whole (`setTextContent`, see setTextEnds) keeps of the text
 * it replaces, as keptStretches gives it for text made again: its common
 * start and end (setTextEnds, so a caret still places an insertion or a
 * deletion), and between them every run of whole words a shortest
 * word-by-word edit script keeps, so that a word a collaborator deletes
 * between two changed words at the same time stays deleted.
 */
export function setTextStretches(
  a: string,
  b: string,
  cursor: number,
  composing: boolean,
): [number, number, number][] {
  const {prefix, suffix} = setTextEnds(a, b, cursor, composing);
  return withKeptWords(a, b, prefix, suffix, composing);
}

/**
 * The common start and end `prefix` and `suffix` of `a` and `b` as ranges
 * (see keptStretches), with every run of whole words kept between them.
 */
function withKeptWords(
  a: string,
  b: string,
  prefix: number,
  suffix: number,
  composing: boolean,
): [number, number, number][] {
  const shift = a.length - b.length;
  const ends: [number, number, number][] = [
    [0, prefix, 0],
    [b.length - suffix, b.length, shift],
  ];
  const a1 = a.length - suffix;
  const b1 = b.length - suffix;
  if (composing || a1 <= prefix || b1 <= prefix) {
    return ends;
  }
  const wa = words(a, prefix, a1);
  const wb = words(b, prefix, b1);
  const ids = new Map<string, number>();
  const id = (text: string, [x0, x1]: [number, number]): number => {
    const t = text.slice(x0, x1);
    let x = ids.get(t);
    if (x === undefined) {
      x = ids.size;
      ids.set(t, x);
    }
    return x;
  };
  const pairs = commonWords(
    wa.map(w => id(a, w)),
    wb.map(w => id(b, w)),
  );
  const out: [number, number, number][] = [ends[0]];
  let lastA = prefix;
  let lastB = prefix;
  for (let i = 0; i < pairs.length; ) {
    // Words kept one after the other with the same white space between
    // them in both texts are one stretch.
    let j = i + 1;
    while (
      j < pairs.length &&
      pairs[j][0] === pairs[j - 1][0] + 1 &&
      pairs[j][1] === pairs[j - 1][1] + 1 &&
      a.slice(wa[pairs[j - 1][0]][1], wa[pairs[j][0]][0]) ===
        b.slice(wb[pairs[j - 1][1]][1], wb[pairs[j][1]][0])
    ) {
      j++;
    }
    let ax = wa[pairs[i][0]][0];
    let bx = wb[pairs[i][1]][0];
    let bEnd = wb[pairs[j - 1][1]][1];
    let aEnd = ax + bEnd - bx;
    // With the white space around it that is the same in both texts (up to
    // the stretch before it), as the start and end keep theirs: only the
    // changed words are written.
    while (
      ax > lastA &&
      bx > lastB &&
      a.charCodeAt(ax - 1) === b.charCodeAt(bx - 1) &&
      isSeparator(a, ax - 1)
    ) {
      ax--;
      bx--;
    }
    while (
      aEnd < a1 &&
      bEnd < b1 &&
      a.charCodeAt(aEnd) === b.charCodeAt(bEnd) &&
      isSeparator(a, aEnd)
    ) {
      aEnd++;
      bEnd++;
    }
    out.push([bx, bEnd, ax - bx]);
    lastA = aEnd;
    lastB = bEnd;
    i = j;
  }
  out.push(ends[1]);
  return out;
}

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;
