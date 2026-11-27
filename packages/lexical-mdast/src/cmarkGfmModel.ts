/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {
  Event,
  Extension as MicromarkExtension,
} from 'micromark-util-types';

import {attention} from 'micromark-core-commonmark';

import {
  classifyCode as classifyCjkCode,
  PUNCTUATION,
  WHITESPACE,
} from './cjkFriendly';
import {
  hasCjkFriendlyVariant,
  isOwnReferenceAgnostic,
  isReferenceNeutral,
} from './compile';

// A model of how micromark pairs `*`, `_` and `~` runs in a subject of the
// strict export's cmark-gfm pass, so that the pass can judge most of its
// proposals without parsing the document again. It follows
// micromark-core-commonmark 2.0.4 (`attention.js`) and
// micromark-extension-gfm-strikethrough 2.1.0 (`syntax.js`); where micromark
// reads otherwise, the drift probe in MdastExport.ts turns it off.

/**
 * The tokens that the cmark-gfm pass reads as its subjects: a paragraph, the
 * text of a heading, a table cell.
 *
 * @internal
 */
export const SUBJECT_TYPES =
  /^(?:atxHeadingText|paragraph|setextHeadingText|tableContent)$/;
// The tokens whose `data` is not read as markers: a link's destination and
// title, and the label of a full reference. Code, HTML, autolinks, escapes
// and character references hold no `data` of their own.
const NO_MARKER_TYPES = /^(?:resource|reference)$/;
// The tokens whose characters may be markers.
const MARKER_TYPES =
  /^(?:data|emphasisSequence|strongSequence|strikethroughSequence)$/;
/**
 * The tokens of the pairs of a subject.
 *
 * @internal
 */
export const PAIR_TYPES = /^(?:emphasis|strikethrough|strong)$/;
// A footnote definition needs footnote syntax, whose `[^` construct turns
// the model off, so only a definition is read.
const DEFINITION_TYPE = 'definition';
/**
 * ASCII punctuation, which a reference may take the place of in other
 * syntax: a link's `]`, a link title's quote.
 *
 * @internal
 */
export const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/;
const MARKERS = '*_~';
// Where GFM may read a literal autolink: `www.`, a protocol or an email's
// `@`. A reference in place of whitespace may end or start one, and in a run
// that holds one (see `literalRuns`) it may change it: all three are
// required. `mailto:`, `xmpp:` and `ftp:` are a deliberate margin: `@` covers
// the first two and micromark reads no `ftp:` literal. Edits inside such runs
// are parsed; the runs are short.
const LITERAL_TRIGGERS = /www\.|https?:|ftp:|mailto:|xmpp:|@/i;

/**
 * The kinds of an item.
 *
 * @internal
 */
export const ATTENTION = 0;
/** @internal */
export const STRIKETHROUGH = 1;
// The classes of an item, as bits: what may pair it.
const ASTERISKS = 1;
const UNDERSCORES = 2;
const TILDE = 4;
const TILDES = 8;

/**
 * A subject of the cmark-gfm pass, as the model reads it.
 *
 * @internal
 */
export interface ModelSubject {
  readonly start: number;
  readonly end: number;
  /** Its place among the subjects of the document, in order. */
  readonly index: number;
}

/**
 * A run of `*`, `_` or `~` that micromark may pair.
 *
 * @internal
 */
export interface ModelItem {
  readonly kind: number;
  readonly marker: string;
  readonly size: number;
  readonly canOpen: boolean;
  readonly canClose: boolean;
  readonly start: number;
}

/**
 * A pair: the offset that its opening sequence starts at, and its key, as
 * the base events key the token of the pair.
 *
 * @internal
 */
export type ModelPair = [open: number, key: string];

/**
 * The class of `code` beside a marker, as micromark's `classifyCharacter`:
 * whitespace, punctuation or 0.
 */
function classifyCode(code: number | null): number {
  return classifyCjkCode(code) & (WHITESPACE | PUNCTUATION);
}

/** What may pair `item`, as one of the class bits. */
function classifyItem(item: ModelItem): number {
  return item.kind === STRIKETHROUGH
    ? item.size === 1
      ? TILDE
      : TILDES
    : item.marker === '*'
      ? ASTERISKS
      : UNDERSCORES;
}

/**
 * `items` as a list linked both ways, so that a resolver takes out the items
 * of a pair without moving the others. Nodes are indices into `items`, which
 * a remnant of a sequence takes the place of; -1 ends the list.
 */
interface LinkedItems {
  readonly items: ModelItem[];
  readonly previous: number[];
  readonly next: number[];
  first: number;
}

/** {@link LinkedItems} of `items`. */
function linkItems(items: readonly ModelItem[]): LinkedItems {
  const previous: number[] = [];
  const next: number[] = [];
  for (let i = 0; i < items.length; i++) {
    previous.push(i - 1);
    next.push(i + 1 < items.length ? i + 1 : -1);
  }
  return {
    first: items.length > 0 ? 0 : -1,
    items: items.slice(),
    next,
    previous,
  };
}

/** Links `left` (or the start of `list`, for -1) to `right` (or its end). */
function linkNodes(list: LinkedItems, left: number, right: number): void {
  if (left < 0) {
    list.first = right;
  } else {
    list.next[left] = right;
  }
  if (right >= 0) {
    list.previous[right] = left;
  }
}

/** The items of `list` from `from` up to `to`, which it leaves out. */
function collectItems(
  list: LinkedItems,
  from: number,
  to: number,
): ModelItem[] {
  const items: ModelItem[] = [];
  for (let node = from; node !== to; node = list.next[node]) {
    items.push(list.items[node]);
  }
  return items;
}

/**
 * The opener that the closer at `node` of `list`, a sequence of `kind`,
 * takes, as micromark's resolver walks back to it: the nearest that may open
 * with the same marker, or for strikethrough the same size, and for
 * attention not ruled out by the rule of three; or -1.
 */
function findOpener(list: LinkedItems, node: number, kind: number): number {
  const closer = list.items[node];
  let open = list.previous[node];
  for (; open >= 0; open = list.previous[open]) {
    const opener = list.items[open];
    if (
      opener.kind !== kind ||
      !opener.canOpen ||
      (kind === ATTENTION
        ? opener.marker !== closer.marker
        : opener.size !== closer.size)
    ) {
      continue;
    }
    // The rule of three only applies to attention.
    if (
      kind === ATTENTION &&
      (opener.canClose || closer.canOpen) &&
      closer.size % 3 &&
      !((opener.size + closer.size) % 3)
    ) {
      continue;
    }
    break;
  }
  return open;
}

/**
 * Pairs the opener at `open` of `list` with the closer at `node`: adds the
 * pair to `pairs`, takes the pair out of `list`, keeps what is left of each
 * sequence, and returns the node to read next, what is left of the closer
 * or the node after it.
 */
function pairNodes(
  list: LinkedItems,
  open: number,
  node: number,
  kind: number,
  pairs: ModelPair[],
): number {
  const opener = list.items[open];
  const closer = list.items[node];
  const use =
    kind === STRIKETHROUGH
      ? closer.size
      : opener.size > 1 && closer.size > 1
        ? 2
        : 1;
  const type =
    kind === STRIKETHROUGH ? 'strikethrough' : use > 1 ? 'strong' : 'emphasis';
  pairs.push([
    opener.start + opener.size - use,
    `${type}@${opener.start + opener.size - use}:${closer.start + use}`,
  ]);
  // What is left of the opener stays, and what is left of the closer is
  // read again. micromark pairs across a closed pair (`*a **b** c*`), so
  // nothing stands in for the pair.
  let left = list.previous[open];
  if (opener.size > use) {
    list.items[open] = {...opener, size: opener.size - use};
    left = open;
  }
  let right = list.next[node];
  if (closer.size > use) {
    list.items[node] = {
      ...closer,
      size: closer.size - use,
      start: closer.start + use,
    };
    right = node;
  }
  linkNodes(list, left, right);
  return right;
}

/**
 * A pair of a {@link RecordedResolution}: -1 for none, or for the top
 * level; from 0, one of its own pairs; from -2 down, a pair of the state
 * that a window of it is resolved in, -2 less its index there.
 */
type PairRef = number;
const NO_PAIR = -1;

/** A pair of the state, as a {@link PairRef} of a window resolved in it. */
function toContextRef(pair: number): PairRef {
  return pair < 0 ? NO_PAIR : -2 - pair;
}

/**
 * What a resolution reads of a sequence: the start of the item, its class,
 * the pair whose interior the pass that read it resolved (its invocation),
 * and, for an opener left over, the pair that took it out of the pass's
 * list, past which no closer reaches it.
 */
interface RecordedEntry {
  readonly start: number;
  readonly itemClass: number;
  readonly invocation: PairRef;
  readonly enclosure: PairRef;
}

/** A pair as {@link resolveRecorded} records it, with its invocation. */
interface RecordedPair {
  readonly kind: number;
  readonly openerStart: number;
  readonly closerStart: number;
  readonly key: string;
  readonly invocation: PairRef;
}

/**
 * The pairs of a resolution, as {@link resolveRecorded} finds them, what
 * micromark's resolvers read of each, the openers they leave over, and the
 * closers that find no opener when read.
 *
 * @internal
 */
export interface RecordedResolution {
  readonly pairs: ModelPair[];
  readonly recordedPairs: RecordedPair[];
  readonly leftovers: RecordedEntry[];
  readonly closers: RecordedEntry[];
}

/**
 * A pass of a resolver over a list: its kind, the pair whose interior the
 * list is (its invocation), the pair that takes the list out, holding what
 * the pass leaves over, and whether the next pass reads the list as it is,
 * as the interior of that pair, rather than without the sequences of this
 * kind, which micromark reads as data once its resolver is done.
 */
interface Pass {
  readonly kind: number;
  readonly invocation: PairRef;
  readonly enclosure: PairRef;
  readonly carries: boolean;
}

/** The passes of `insideSpan` over the interior of `pair`. */
function passesInside(pair: PairRef): Pass[] {
  return [
    {carries: false, enclosure: NO_PAIR, invocation: pair, kind: STRIKETHROUGH},
    {carries: false, enclosure: NO_PAIR, invocation: pair, kind: ATTENTION},
  ];
}

/**
 * Runs `passes` over `items`, recording what they read. A pair that a pass
 * forms has its interior read by the passes of `insideSpan`, as micromark
 * does, also where the sequences of a kind were read before: what is left
 * of one after a pair may pass the rule of three where it did not.
 */
function recordPasses(
  items: ModelItem[],
  passes: readonly Pass[],
  recorded: RecordedResolution,
): void {
  let list = items;
  for (const pass of passes) {
    const linked = recordPass(list, pass, recorded);
    list = pass.carries
      ? linked
      : linked.filter(item => item.kind !== pass.kind);
  }
}

/**
 * A pass over `items`, which records what it reads and returns the items
 * still in its list at its end.
 */
function recordPass(
  items: ModelItem[],
  {kind, invocation, enclosure}: Pass,
  recorded: RecordedResolution,
): ModelItem[] {
  const list = linkItems(items);
  let node = list.first;
  while (node >= 0) {
    const closer = list.items[node];
    if (closer.kind !== kind || !closer.canClose) {
      node = list.next[node];
      continue;
    }
    const open = findOpener(list, node, kind);
    if (open < 0) {
      recorded.closers.push({
        enclosure: NO_PAIR,
        invocation,
        itemClass: classifyItem(closer),
        start: closer.start,
      });
      node = list.next[node];
      continue;
    }
    const pair = recorded.recordedPairs.length;
    const between = collectItems(list, list.next[open], node);
    const openerStart = list.items[open].start;
    const closerStart = closer.start;
    node = pairNodes(list, open, node, kind, recorded.pairs);
    recorded.recordedPairs.push({
      closerStart,
      invocation,
      key: recorded.pairs[recorded.pairs.length - 1][1],
      kind,
      openerStart,
    });
    for (const item of between) {
      if (item.kind === kind && item.canOpen) {
        recorded.leftovers.push({
          enclosure: pair,
          invocation,
          itemClass: classifyItem(item),
          start: item.start,
        });
      }
    }
    recordPasses(between, passesInside(pair), recorded);
  }
  const linked: ModelItem[] = [];
  for (let n = list.first; n >= 0; n = list.next[n]) {
    const item = list.items[n];
    linked.push(item);
    if (item.kind === kind && item.canOpen) {
      recorded.leftovers.push({
        enclosure,
        invocation,
        itemClass: classifyItem(item),
        start: item.start,
      });
    }
  }
  return linked;
}

/** An empty {@link RecordedResolution}. */
function createRecorded(): RecordedResolution {
  return {closers: [], leftovers: [], pairs: [], recordedPairs: []};
}

/**
 * The pairs of `items` as {@link resolveRecorded} finds them, with what
 * micromark's resolvers read of each.
 *
 * @internal
 */
export function resolveRecorded(
  items: ModelItem[],
  strikethroughFirst: boolean,
): RecordedResolution {
  const recorded = createRecorded();
  recordPasses(
    items,
    (strikethroughFirst
      ? [STRIKETHROUGH, ATTENTION]
      : [ATTENTION, STRIKETHROUGH]
    ).map(kind => ({
      carries: false,
      enclosure: NO_PAIR,
      invocation: NO_PAIR,
      kind,
    })),
    recorded,
  );
  return recorded;
}

/**
 * The first index of `sorted` whose value is more than `value`.
 *
 * @internal
 */
export function upperBound(sorted: ArrayLike<number>, value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] <= value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** The pairs in the order of their openings. */
function sortPairs(pairs: ModelPair[]): ModelPair[] {
  return pairs.sort((a, b) => a[0] - b[0]);
}

/** The keys of `pairs`, as one string that does not depend on their order. */
function joinKeys(pairs: readonly ModelPair[]): string {
  return pairs
    .map(pair => pair[1])
    .sort()
    .join(',');
}

/** A hook of an extension, a code in it and what the code holds. */
type ExtensionEntry = [hook: string, code: string, values: unknown[]];

/**
 * The entries of `extension` as micromark's `combineExtensions` reads them:
 * every hook and code that `for…in` finds, inherited ones too, with what
 * each code adds.
 */
function readEntries(extension: MicromarkExtension): ExtensionEntry[] {
  const entries: ExtensionEntry[] = [];
  for (const hook in extension) {
    const record: unknown = Reflect.get(extension, hook);
    if (!record) {
      continue;
    }
    // A string or number too, as micromark reads it.
    const object: object = Object(record);
    for (const code in object) {
      const value: unknown = Reflect.get(object, code);
      const values = Array.isArray(value) ? value : value ? [value] : [];
      // micromark adds no construct for an empty list.
      if (values.length > 0) {
        entries.push([hook, code, values]);
      }
    }
  }
  return entries;
}

/** Whether `entries` are exactly `expected`, in any order. */
function hasEntries(
  entries: readonly ExtensionEntry[],
  expected: readonly ExtensionEntry[],
): boolean {
  return (
    entries.length === expected.length &&
    expected.every(([hook, code, values]) =>
      entries.some(
        entry =>
          entry[0] === hook &&
          entry[1] === code &&
          entry[2].length === values.length &&
          entry[2].every((value, i) => value === values[i]),
      ),
    )
  );
}

// What an extension is to the model.
const EMPHASIS = 'emphasis';
const STRIKETHROUGH_SYNTAX = 'strikethrough';
const NEUTRAL = 'neutral';

/**
 * What the model reads `extension` as, by every construct it holds: the
 * strict emphasis (micromark-core-commonmark's own `attention` at `*` and
 * `_` and as its span resolver, and nothing else), lexical's GFM
 * strikethrough syntax (from `getStrikethroughSyntax`, with its tokenizer at
 * `~` and as its span resolver, `~` as an attention marker, and nothing
 * else), or syntax that does not change how attention pairs: no construct
 * at a marker, no attention marker, no span resolver, text constructs only
 * if marked by `referenceAgnostic` (GFM literals, whose email literal
 * starts at `_`, and task list items), and other constructs only if marked
 * by `referenceNeutral` (GFM tables): a flow construct may read a line
 * otherwise once its first character is a reference. null for anything
 * else, which turns the model off, as does an extension that disables a
 * construct.
 */
function classifyExtension(
  extension: MicromarkExtension,
): typeof EMPHASIS | typeof STRIKETHROUGH_SYNTAX | typeof NEUTRAL | null {
  const entries = readEntries(extension);
  if (
    hasEntries(entries, [
      ['text', '42', [attention]],
      ['text', '95', [attention]],
      ['insideSpan', 'null', [attention]],
    ])
  ) {
    return EMPHASIS;
  }
  if (hasCjkFriendlyVariant(extension)) {
    const tilde = entries.find(
      ([hook, code]) => hook === 'text' && code === '126',
    );
    return tilde &&
      tilde[2].length === 1 &&
      hasEntries(entries, [
        ['text', '126', tilde[2]],
        ['insideSpan', 'null', tilde[2]],
        ['attentionMarkers', 'null', [126]],
      ])
      ? STRIKETHROUGH_SYNTAX
      : null;
  }
  for (const [hook, code] of entries) {
    if (
      hook === 'disable' ||
      hook === 'attentionMarkers' ||
      hook === 'insideSpan' ||
      (hook === 'text'
        ? code === '42' || code === '126' || !isOwnReferenceAgnostic(extension)
        : !isReferenceNeutral(extension))
    ) {
      return null;
    }
  }
  return NEUTRAL;
}

/**
 * Whether the model reads micromark with `extensions`, a strict import's, as
 * micromark does: they hold the strict emphasis and lexical's strikethrough
 * syntax, and otherwise only syntax that {@link classifyExtension} finds
 * neutral.
 *
 * @internal
 */
export function isModelConfiguration(
  extensions: readonly MicromarkExtension[],
): boolean {
  let hasEmphasis = false;
  let hasStrikethrough = false;
  for (const extension of extensions) {
    const kind = classifyExtension(extension);
    if (kind === null) {
      return false;
    }
    hasEmphasis ||= kind === EMPHASIS;
    hasStrikethrough ||= kind === STRIKETHROUGH_SYNTAX;
  }
  return hasEmphasis && hasStrikethrough;
}

// A number for each construct that a configuration holds, so that a key of
// the constructs reads the same for every editor with the same syntax. Made
// on first use, so nothing runs as the module loads.
let constructIds: WeakMap<object, number> | null = null;
let nextConstructId = 0;

/**
 * A key of `extensions`, which {@link isModelConfiguration} accepts: the
 * strict emphasis and lexical's strikethrough syntax by what they are, as
 * every one of them reads alike, and for each other extension, each hook
 * and code with its constructs by identity. Two lists with one key read
 * Markdown alike; an editor compiles its own list, mostly from syntax
 * objects that every editor shares.
 *
 * @internal
 */
export function keyConfiguration(
  extensions: readonly MicromarkExtension[],
): string {
  const ids = (constructIds ||= new WeakMap());
  const keyValue = (value: unknown): string => {
    if (typeof value !== 'object' && typeof value !== 'function') {
      return String(value);
    }
    if (value === null) {
      return 'null';
    }
    let id = ids.get(value);
    if (id === undefined) {
      id = nextConstructId++;
      ids.set(value, id);
    }
    return `#${id}`;
  };
  return extensions
    .map(extension => {
      const kind = classifyExtension(extension);
      return kind === EMPHASIS || kind === STRIKETHROUGH_SYNTAX
        ? kind
        : readEntries(extension)
            .map(
              ([hook, code, values]) =>
                `${hook}:${code}=${values.map(keyValue).join('+')}`,
            )
            .join(' ');
    })
    .join(' | ');
}

/**
 * Short documents that reach each rule of the model, which the drift probe
 * in MdastExport.ts compares with micromark: `~` beside `*`, single and
 * triple tildes, escapes, the rule of three, link labels, partners that
 * change, symbols, astral characters, U+0000, container prefixes, a
 * backslash, the attention rules that changed in micromark-core-commonmark
 * patches, a `[^…]` label, code, a hard break, nested labels, a link's
 * destination and title, and a label whose pairs depend on strikethrough
 * resolving first. Each is read as a paragraph (in a quote or a list item
 * for the two with a prefix); one at the start of a line would be a fenced
 * code block (`~~~a~~~`).
 *
 * @internal
 */
export const CMARK_GFM_MODEL_FIXTURES: readonly string[] = [
  '*~*a',
  'a*~*a',
  '~~**x**~~ a',
  '~a~ b',
  'x ~~~a~~~',
  '*\\**a*',
  '*_a_*b',
  '**a*b',
  '***a** b*',
  '[*a*](u) *b [c*](u)',
  '~~_a\\~\\~ba\\~\\~b_€a_b\\a~~___`!_.`___',
  '*`b`_©_a_©_a__©*a*',
  '©_a_ *x*©',
  '_x_😀 *🎉*a',
  'a*\u0000*a',
  '>_b\n>_*~*a',
  '- *a\n  b*©',
  '\\©_a_',
  'foo**_bar_**baz',
  '*foo\\**bar*',
  '[^a *b*] *c*',
  '`a*`*b*',
  'a\\\n*b*',
  '[*a ![b*](i) c*](u) ©_d_',
  '[x](u*a* "b*c*") ©_a_',
  '[~a *b~ c*](u)',
];

/**
 * How the model reads the subjects of a document.
 *
 * @internal
 */
export interface CmarkGfmModel {
  /** Whether the model reads the pairs of `subject` as micromark did. */
  readsBase(subject: ModelSubject): boolean;
  /** How many items the model has read, which bounds its work. */
  countItemsRead(): number;
  /**
   * How many positions of marker runs it has read them from, and of
   * subjects it has read for brackets.
   */
  countPositionsRead(): number;
  /**
   * How many entries the states of subjects have taken in or off, and how
   * many accepted edits it has read, which bounds the work of keeping them.
   */
  countStateWork(): number;
  /**
   * Whether `subject` reads as before with `accepted`, its edits so far, and
   * `proposed`, edits of it that `accepted` does not hold, when it reads as
   * before with `accepted`; or null where a parse judges, as the model may
   * not read the edits. Read against the model of `accepted`, around the
   * proposed edits. Between judgements, `accepted` only gains edits, or is
   * replaced by another set; once a proposal is kept, it gains its edits
   * before the next judgement of the subject.
   */
  judge(
    subject: ModelSubject,
    accepted: ReadonlySet<number>,
    proposed: readonly number[],
  ): boolean | null;
  /** {@link CmarkGfmModel.judge}, from the pairs of the whole subject. */
  judgeWhole(
    subject: ModelSubject,
    accepted: ReadonlySet<number>,
    proposed: readonly number[],
  ): boolean | null;
}

/**
 * The offsets of the characters that a pass writes as references.
 *
 * @internal
 */
export interface Edits {
  has(offset: number): boolean;
}

/**
 * `edits` with `added` too.
 *
 * @internal
 */
export function withEdits(edits: Edits, added: readonly number[]): Edits {
  return added.length === 0
    ? edits
    : {has: offset => added.includes(offset) || edits.has(offset)};
}

/**
 * Values over positions, a tree of the largest or of the smallest, which
 * finds the nearest position whose value passes a bound in logarithmic
 * time. Leaves are at `size` and on.
 */
interface SearchTree {
  readonly size: number;
  readonly values: Int32Array;
  readonly isMax: boolean;
}

// The value of a position with nothing at it, in a tree of the largest and
// in one of the smallest.
const NO_MAX = -1;
const NO_MIN = 0x7fffffff;

/** A {@link SearchTree} over `count` positions with nothing at them. */
function createSearchTree(count: number, isMax: boolean): SearchTree {
  let size = 1;
  while (size < count) {
    size <<= 1;
  }
  return {
    isMax,
    size,
    values: new Int32Array(2 * size).fill(isMax ? NO_MAX : NO_MIN),
  };
}

/** Sets the value at `index` of `tree`. */
function setSearchValue(tree: SearchTree, index: number, value: number): void {
  const {values} = tree;
  let node = index + tree.size;
  values[node] = value;
  for (node >>= 1; node > 0; node >>= 1) {
    values[node] = tree.isMax
      ? Math.max(values[2 * node], values[2 * node + 1])
      : Math.min(values[2 * node], values[2 * node + 1]);
  }
}

/**
 * The last position in [from, to) whose value in `tree`, of the largest, is
 * at least `bound`, or -1. Callers pass `from` = 0; it is kept for symmetry
 * with `findFirstBelow`.
 */
function findLastAtLeast(
  tree: SearchTree,
  from: number,
  to: number,
  bound: number,
  node = 1,
  low = 0,
  high = tree.size,
): number {
  if (high <= from || low >= to || tree.values[node] < bound) {
    return -1;
  }
  if (high - low === 1) {
    return low;
  }
  const middle = (low + high) >> 1;
  const right = findLastAtLeast(
    tree,
    from,
    to,
    bound,
    2 * node + 1,
    middle,
    high,
  );
  return right >= 0
    ? right
    : findLastAtLeast(tree, from, to, bound, 2 * node, low, middle);
}

/**
 * The first position in [from, to) whose value in `tree`, of the smallest,
 * is below `bound`, or -1. Callers pass `to` = the count of positions; it
 * is kept for symmetry with `findLastAtLeast`.
 */
function findFirstBelow(
  tree: SearchTree,
  from: number,
  to: number,
  bound: number,
  node = 1,
  low = 0,
  high = tree.size,
): number {
  if (high <= from || low >= to || tree.values[node] >= bound) {
    return -1;
  }
  if (high - low === 1) {
    return low;
  }
  const middle = (low + high) >> 1;
  const left = findFirstBelow(tree, from, to, bound, 2 * node, low, middle);
  return left >= 0
    ? left
    : findFirstBelow(tree, from, to, bound, 2 * node + 1, middle, high);
}

// The class bits of an item, as indices.
const CLASS_BITS = [ASTERISKS, UNDERSCORES, TILDE, TILDES];

/**
 * The model of a subject with a set of edits, its items outside link labels
 * resolved, kept over those items, which the edits do not move. A kept
 * window has the pairs it had, so the pairs and what they hold do not
 * change; what the items leave over and fail on may.
 */
interface ModelState {
  /**
   * Whether the first item is strikethrough, which then resolves first. An
   * edit is never at a marker, so the edits do not change it.
   */
  readonly strikethroughFirst: boolean;
  /** The pairs in link labels, as {@link joinKeys} keys them. */
  readonly labelKeys: string;
  /** The starts of the items outside link labels. */
  readonly starts: number[];
  /** Their pairs, by opening, and where each opens. */
  readonly pairs: ModelPair[];
  readonly openings: number[];
  /**
   * For each pair, by the index {@link resolveRecorded} gives it: the items
   * of its opener and closer, the pair that holds it next, how many pairs
   * hold it, the classes of the openers and of the closers of it and the
   * pairs that hold it, its kind, and the pair whose interior the pass that
   * formed it read, or -1.
   */
  readonly pairOpen: Int32Array;
  readonly pairClose: Int32Array;
  readonly pairParent: Int32Array;
  readonly pairDepth: Int32Array;
  readonly pairOpenClasses: Uint8Array;
  readonly pairCloseClasses: Uint8Array;
  readonly pairKind: Uint8Array;
  readonly pairInvocation: Int32Array;
  readonly pairByKey: Map<string, number>;
  /** For each item, the innermost pair whose span holds its start, or -1. */
  readonly innermost: Int32Array;
  /**
   * For each class, over the items: for an opener left over, the last item
   * before which a closer reaches it (its pass's interior and the pair that
   * takes it out end there); for a closer that found no opener, the opener
   * of the pair whose interior its pass read, or -1.
   */
  readonly leftovers: SearchTree[];
  readonly closers: SearchTree[];
  /** What each item adds to those, as class and value, for a window. */
  readonly leftoversAt: (number[] | undefined)[];
  readonly closersAt: (number[] | undefined)[];
}

/**
 * The accepted edits of a subject as a judge last read them: whether they
 * hold an edit that a parse must judge (ASCII punctuation, or whitespace
 * where a literal trigger is), the model of the subject with them once built,
 * and, after a kept judgement, its size with the kept edits and how to make
 * the model of those.
 */
interface AcceptedEdits {
  readonly edits: ReadonlySet<number>;
  readonly size: number;
  readonly hasParsedEdit: boolean;
  state?: ModelState;
  keptSize?: number;
  adopt?: () => ModelState;
}

/**
 * The model of `markdown`, from `events`, micromark's reading of it with a
 * configuration that {@link isModelConfiguration} accepts.
 *
 * Items are the maximal runs of markers in the text of a subject outside
 * code, links' destinations, references, escapes and autolinks; a character
 * that an edit writes as a reference is not a marker, and reads as `;` after
 * a run and `&` before one. A judge resolves the items with the edits as
 * micromark would and compares the pairs with those of the accepted edits.
 * It resolves only a window around the proposed edits, inside the
 * interior of the innermost pair that holds them all (its level), between
 * items whose innermost pair is that one: no pair crosses the window's
 * edges. The window is read by the passes that read its items: those of
 * the top, then of each pair formed around it, in to its level. It widens
 * to a leftover opener before it or a failed closer after it of a class
 * that the window may pair with, from a pass that read the window too:
 * closers look only back, so the items outside the window resolve as
 * before. Where a closer the window fails may take the opener of a pair
 * around it, or a leftover in it the closer of one, or what it may pair
 * with is outside the level, it is judged a level up, at most at the top.
 * The windows are checked left to right, and one whose closers may take
 * what an earlier one leaves over takes that one in. Where an edit is in a
 * link label, which resolves on its own, the whole subject is resolved
 * again.
 *
 * @internal
 */
export function createCmarkGfmModel(
  markdown: string,
  events: readonly Event[],
): CmarkGfmModel {
  const {length} = markdown;
  // The characters that may be markers, and those in the text of a subject,
  // beside which a marker reads the character rather than an edge.
  const isMarkerText = new Uint8Array(length);
  const isText = new Uint8Array(length);
  const labels: [start: number, end: number][] = [];
  const basePairs: string[][] = [];
  const prefixes: [start: number, end: number][] = [];
  // Where the destination and title of an inline link or image start.
  const isResourceStart = new Uint8Array(length);
  let hasDefinitions = false;
  const hasLiterals = LITERAL_TRIGGERS.test(markdown);
  let noMarkerDepth = 0;
  let inSubject = false;
  for (const [kind, token] of events) {
    const type: string = token.type;
    const start = token.start.offset;
    const end = token.end.offset;
    if (SUBJECT_TYPES.test(type)) {
      inSubject = kind === 'enter';
      if (inSubject) {
        basePairs.push([]);
        isText.fill(1, start, end);
      }
      continue;
    }
    // A definition may make a link of brackets, which a reference in them
    // may change the label of.
    if (kind === 'enter' && type === DEFINITION_TYPE) {
      hasDefinitions = true;
    }
    if (!inSubject) {
      continue;
    }
    if (kind === 'enter' && type === 'resource') {
      isResourceStart[start] = 1;
    }
    if (NO_MARKER_TYPES.test(type)) {
      noMarkerDepth += kind === 'enter' ? 1 : -1;
    }
    if (kind !== 'enter') {
      continue;
    }
    if (/Prefix$/.test(type)) {
      prefixes.push([start, end]);
    } else if (type === 'labelText') {
      labels.push([start, end]);
    } else if (noMarkerDepth === 0 && MARKER_TYPES.test(type)) {
      isMarkerText.fill(1, start, end);
    } else if (PAIR_TYPES.test(type)) {
      basePairs[basePairs.length - 1].push(`${type}@${start}:${end}`);
    }
  }
  // A container prefix is not in the text: before the first character of a
  // line, micromark reads the line ending.
  for (const [start, end] of prefixes) {
    isText.fill(0, start, end);
  }
  // The runs of one marker, which the edits do not move: none is at a
  // marker. A window reads its items from the runs it holds, not from every
  // character between them.
  const runStarts: number[] = [];
  const runEnds: number[] = [];
  for (let i = 0; i < length; ) {
    if (isMarkerText[i] && MARKERS.includes(markdown[i])) {
      let j = i + 1;
      while (j < length && isMarkerText[j] && markdown[j] === markdown[i]) {
        j++;
      }
      runStarts.push(i);
      runEnds.push(j);
      i = j;
    } else {
      i++;
    }
  }

  let itemsRead = 0;
  let positionsRead = 0;
  // The runs read, items or not (a run of three `~`).
  let runsRead = 0;
  let stateWork = 0;
  /** The items of `subject` with `edits` that start in [from, to). */
  const readItems = (
    subject: ModelSubject,
    from: number,
    to: number,
    edits: Edits,
  ) => {
    const items: ModelItem[] = [];
    const {start, end} = subject;
    // micromark reads UTF-16 code units, with U+0000 as U+FFFD.
    const readUnit = (i: number) => {
      const code = markdown.charCodeAt(i);
      return code === 0 ? 0xfffd : code;
    };
    const readPrevious = (i: number): number | null => {
      const p = i - 1;
      if (p < start || !isText[p]) {
        return null;
      }
      // The end of a reference, also of one for an astral character, whose
      // low half is at `p`.
      if (
        edits.has(p) ||
        (p > start &&
          edits.has(p - 1) &&
          (markdown.charCodeAt(p) & 0xfc00) === 0xdc00 &&
          (markdown.charCodeAt(p - 1) & 0xfc00) === 0xd800)
      ) {
        return 59;
      }
      return readUnit(p);
    };
    const readNext = (i: number): number | null => {
      if (i >= end) {
        return null;
      }
      return edits.has(i) ? 38 : readUnit(i);
    };
    // Each run is an item: an edit is never at a marker, as a parse judges
    // one in place of ASCII punctuation.
    for (
      let run = upperBound(runStarts, from - 1);
      run < runStarts.length && runStarts[run] < to;
      run++
    ) {
      runsRead++;
      const i = runStarts[run];
      const j = runEnds[run];
      const marker = markdown[i];
      positionsRead += j - i;
      const previous = readPrevious(i);
      const code = readNext(j);
      const before = classifyCode(previous);
      const after = classifyCode(code);
      if (marker === '~') {
        // micromark reads a run of three or more as text.
        if (j - i <= 2) {
          items.push({
            canClose: !before || (before === PUNCTUATION && Boolean(after)),
            canOpen: !after || (after === PUNCTUATION && Boolean(before)),
            kind: STRIKETHROUGH,
            marker,
            size: j - i,
            start: i,
          });
        }
      } else {
        // Beside a `~`, an attention marker of the strikethrough syntax.
        const open =
          !after || (after === PUNCTUATION && Boolean(before)) || code === 126;
        const close =
          !before ||
          (before === PUNCTUATION && Boolean(after)) ||
          previous === 126;
        items.push({
          canClose: marker === '*' ? close : close && (Boolean(after) || !open),
          canOpen: marker === '*' ? open : open && (Boolean(before) || !close),
          kind: ATTENTION,
          marker,
          size: j - i,
          start: i,
        });
      }
    }
    itemsRead += items.length;
    return items;
  };

  // The innermost link label at each offset, or -1: the labels enter in
  // the order of their starts, so a label inside another fills after it.
  let labelAt: Int32Array | null = null;
  const getLabelAt = () => {
    if (!labelAt) {
      labelAt = new Int32Array(length).fill(-1);
      labels.forEach(([start, end], i) => labelAt!.fill(i, start, end));
    }
    return labelAt;
  };
  const isInLabel = (item: ModelItem) => getLabelAt()[item.start] >= 0;
  // Resolves the items in link labels into `pairs`, each label on its own,
  // and returns the others. micromark resolves the innermost first, but as
  // the labels share no items and pairs are compared as a set, the order
  // does not matter.
  const resolveLabels = (items: ModelItem[], pairs: ModelPair[]) => {
    const at = getLabelAt();
    const rest: ModelItem[] = [];
    const groups = new Map<number, ModelItem[]>();
    for (const item of items) {
      const label = at[item.start];
      if (label < 0) {
        rest.push(item);
      } else {
        const group = groups.get(label);
        if (group) {
          group.push(item);
        } else {
          groups.set(label, [item]);
        }
      }
    }
    for (const group of groups.values()) {
      for (const pair of resolveRecorded(group, true).pairs) {
        pairs.push(pair);
      }
    }
    return rest;
  };
  // The items of `subject` with `edits` outside link labels, the pairs in
  // the labels, and whether strikethrough resolves first: micromark runs
  // its resolvers in the order it first uses their constructs, and reads a
  // label's text as the rest, so the first item decides, in a label or not.
  const readSubject = (subject: ModelSubject, edits: Edits) => {
    const items = readItems(subject, subject.start, subject.end, edits);
    const labelPairs: ModelPair[] = [];
    const rest = resolveLabels(items, labelPairs);
    const strikethroughFirst =
      items.length > 0 && items[0].kind === STRIKETHROUGH;
    return {labelPairs, rest, strikethroughFirst};
  };
  // All the pairs of `subject` with `edits`, as one key.
  const readPairs = (subject: ModelSubject, edits: Edits) => {
    const {labelPairs, rest, strikethroughFirst} = readSubject(subject, edits);
    for (const pair of resolveRecorded(rest, strikethroughFirst).pairs) {
      labelPairs.push(pair);
    }
    return joinKeys(labelPairs);
  };

  // The index of the item of `state` that holds `offset`.
  const itemAt = (state: ModelState, offset: number) =>
    upperBound(state.starts, offset) - 1;
  // Sets the value of each class at `index` of `state` from what is there.
  const setValues = (state: ModelState, index: number) => {
    CLASS_BITS.forEach((itemClass, c) => {
      let leftover = NO_MAX;
      let closer = NO_MIN;
      const leftovers = state.leftoversAt[index] || [];
      for (let k = 0; k < leftovers.length; k += 2) {
        if (leftovers[k] === itemClass) {
          leftover = Math.max(leftover, leftovers[k + 1]);
        }
      }
      const closers = state.closersAt[index] || [];
      for (let k = 0; k < closers.length; k += 2) {
        if (closers[k] === itemClass) {
          closer = Math.min(closer, closers[k + 1]);
        }
      }
      setSearchValue(state.leftovers[c], index, leftover);
      setSearchValue(state.closers[c], index, closer);
    });
  };
  // Adds what `recorded` leaves over and fails on to `state`, its own pairs
  // being those of `state` with the same keys.
  const addRecorded = (state: ModelState, recorded: RecordedResolution) => {
    const n = state.starts.length;
    const toPair = (ref: PairRef) =>
      ref >= 0
        ? state.pairByKey.get(recorded.recordedPairs[ref].key)!
        : ref === NO_PAIR
          ? NO_PAIR
          : -2 - ref;
    const closeOf = (pair: number) => (pair < 0 ? n : state.pairClose[pair]);
    const touched = new Set<number>();
    stateWork += recorded.leftovers.length + recorded.closers.length;
    for (const {
      start,
      itemClass,
      invocation,
      enclosure,
    } of recorded.leftovers) {
      const at = itemAt(state, start);
      (state.leftoversAt[at] ||= []).push(
        itemClass,
        Math.min(closeOf(toPair(invocation)), closeOf(toPair(enclosure))),
      );
      touched.add(at);
    }
    // A closer counts at the item it is part of: what is left of a closer
    // after a pair starts inside its run.
    for (const {start, itemClass, invocation} of recorded.closers) {
      const at = itemAt(state, start);
      const pair = toPair(invocation);
      (state.closersAt[at] ||= []).push(
        itemClass,
        pair < 0 ? -1 : state.pairOpen[pair],
      );
      touched.add(at);
    }
    for (const at of touched) {
      setValues(state, at);
    }
  };
  // Takes off what the items in [from, to) of `state` leave over and fail on.
  const removeItems = (state: ModelState, from: number, to: number) => {
    stateWork += to - from;
    for (let i = from; i < to; i++) {
      if (state.leftoversAt[i] || state.closersAt[i]) {
        state.leftoversAt[i] = undefined;
        state.closersAt[i] = undefined;
        setValues(state, i);
      }
    }
  };
  const buildState = (
    subject: ModelSubject,
    edits: ReadonlySet<number>,
    proposed: readonly number[],
  ): ModelState => {
    const {labelPairs, rest, strikethroughFirst} = readSubject(
      subject,
      withEdits(edits, proposed),
    );
    const recorded = resolveRecorded(rest, strikethroughFirst);
    const {pairs, recordedPairs} = recorded;
    const n = rest.length;
    const count = recordedPairs.length;
    const starts = rest.map(item => item.start);
    const pairOpen = new Int32Array(count);
    const pairClose = new Int32Array(count);
    const pairParent = new Int32Array(count).fill(-1);
    const pairDepth = new Int32Array(count);
    const pairOpenClasses = new Uint8Array(count);
    const pairCloseClasses = new Uint8Array(count);
    const pairKind = new Uint8Array(count);
    const pairInvocation = new Int32Array(count).fill(-1);
    const pairByKey = new Map<string, number>();
    // A pair from a to b spans the starts in (a, b]: the items after its
    // opener's, up to its closer's. Pairs nest, so sorted by where their
    // items start, and the wider first, each is held by the nearest before
    // it that is still open.
    recordedPairs.forEach(
      ({openerStart, closerStart, key, kind, invocation}, pair) => {
        pairOpen[pair] = upperBound(starts, openerStart) - 1;
        pairClose[pair] = upperBound(starts, closerStart) - 1;
        pairKind[pair] = kind;
        pairInvocation[pair] = invocation;
        pairByKey.set(key, pair);
      },
    );
    const order = recordedPairs
      .map((_, pair) => pair)
      .sort(
        (a, b) =>
          pairOpen[a] - pairOpen[b] ||
          pairClose[b] - pairClose[a] ||
          recordedPairs[a].openerStart - recordedPairs[b].openerStart ||
          recordedPairs[b].closerStart - recordedPairs[a].closerStart,
      );
    const innermost = new Int32Array(n).fill(-1);
    const open: number[] = [];
    let next = 0;
    for (let i = 0; i < n; i++) {
      while (open.length > 0 && pairClose[open[open.length - 1]] < i) {
        open.pop();
      }
      while (next < order.length && pairOpen[order[next]] < i) {
        const pair = order[next++];
        while (
          open.length > 0 &&
          pairClose[open[open.length - 1]] < pairClose[pair]
        ) {
          open.pop();
        }
        const parent = open.length > 0 ? open[open.length - 1] : -1;
        pairParent[pair] = parent;
        pairDepth[pair] = parent < 0 ? 1 : pairDepth[parent] + 1;
        pairOpenClasses[pair] =
          (parent < 0 ? 0 : pairOpenClasses[parent]) |
          classifyItem(rest[pairOpen[pair]]);
        pairCloseClasses[pair] =
          (parent < 0 ? 0 : pairCloseClasses[parent]) |
          classifyItem(rest[pairClose[pair]]);
        open.push(pair);
      }
      innermost[i] = open.length > 0 ? open[open.length - 1] : -1;
    }
    const sortedPairs = sortPairs(pairs);
    const state: ModelState = {
      closers: CLASS_BITS.map(() => createSearchTree(n, false)),
      closersAt: [],
      innermost,
      labelKeys: joinKeys(labelPairs),
      leftovers: CLASS_BITS.map(() => createSearchTree(n, true)),
      leftoversAt: [],
      openings: sortedPairs.map(pair => pair[0]),
      pairByKey,
      pairClose,
      pairCloseClasses,
      pairDepth,
      pairInvocation,
      pairKind,
      pairOpen,
      pairOpenClasses,
      pairParent,
      pairs: sortedPairs,
      starts,
      strikethroughFirst,
    };
    addRecorded(state, recorded);
    return state;
  };
  const keyState = (state: ModelState) =>
    `${joinKeys(state.pairs)}|${state.labelKeys}`;

  // What a judgement at a level returns where it cannot judge there: the
  // edits may reach past the level, or the windows cost more than the whole
  // subject.
  const CLIMB = -2;
  const WHOLE = -3;
  const judgeIncrementally = (
    subject: ModelSubject,
    known: AcceptedEdits,
    proposed: readonly number[],
  ): boolean => {
    const accepted = known.edits;
    const before = (known.state ||= buildState(subject, accepted, []));
    const own = withEdits(accepted, proposed);
    const judgeWhole = () => {
      const after = buildState(subject, accepted, proposed);
      const isKept = keyState(after) === keyState(before);
      if (isKept) {
        known.adopt = () => after;
      }
      return isKept;
    };
    // The markers around each edit, which it may change the reading of.
    const isMarker = (i: number) =>
      i >= subject.start && i < subject.end && MARKERS.includes(markdown[i]);
    // A run that ends before the edit starts at or before `low`, where the
    // window starts anyway; one after it may start after the low half of an
    // astral character.
    const regions = [...proposed]
      .sort((a, b) => a - b)
      .map(offset => {
        const low = offset - 1;
        let high = offset + 1;
        while (isMarker(high + 1)) {
          high++;
        }
        return [low, high];
      });
    // Label boundaries are ASCII, so an edit changes a label only where it
    // sits inside one; a boundary next to it goes to a parse verdict.
    if (proposed.some(offset => getLabelAt()[offset] >= 0)) {
      return judgeWhole();
    }
    const {starts, innermost, pairParent, pairDepth} = before;
    const n = starts.length;
    // The runs that the windows of this judgement read, those in link labels
    // and those that are no item too. Widening a window reads it again, so
    // past twice the items of the subject, resolving the whole subject once
    // costs less.
    let runsInWindows = 0;
    const coverOf = (i: number) => (i < 0 || i >= n ? -1 : innermost[i]);
    const commonPair = (a: number, b: number) => {
      while (a !== b && a >= 0 && b >= 0) {
        if (pairDepth[a] >= pairDepth[b]) {
          a = pairParent[a];
        } else {
          b = pairParent[b];
        }
      }
      return a === b ? a : -1;
    };
    // The level: the innermost pair whose span holds the items beside every
    // edit, or the top.
    let level =
      regions.length > 0 ? coverOf(upperBound(starts, regions[0][0]) - 1) : -1;
    for (const [low, high] of regions) {
      level = commonPair(level, coverOf(upperBound(starts, low) - 1));
      level = commonPair(level, coverOf(upperBound(starts, high)));
    }
    // The passes that read the items of a window inside the interior of
    // `at`: those of the top, then of each pair that a pass before formed,
    // from the top in to `at`, each up to the pass that formed the next,
    // which takes the window out of its list. What a pass leaves over in
    // the window is taken out by that pair.
    const passesTo = (at: number): Pass[] => {
      const chain: number[] = [];
      for (let pair = at; pair >= 0; pair = before.pairInvocation[pair]) {
        chain.unshift(pair);
      }
      const kinds = before.strikethroughFirst
        ? [STRIKETHROUGH, ATTENTION]
        : [ATTENTION, STRIKETHROUGH];
      const passes: Pass[] = [];
      [-1, ...chain].forEach((pair, i) => {
        const next = i < chain.length ? chain[i] : -1;
        for (const kind of pair < 0 ? kinds : [STRIKETHROUGH, ATTENTION]) {
          const formsNext = next >= 0 && before.pairKind[next] === kind;
          passes.push({
            carries: formsNext,
            enclosure: formsNext ? toContextRef(next) : NO_PAIR,
            invocation: toContextRef(pair),
            kind,
          });
          if (formsNext) {
            break;
          }
        }
      });
      return passes;
    };
    // Judges the edits with windows inside the interior of `at`, a pair, or
    // the top: 1 or 0, CLIMB where they may reach past it, or WHOLE.
    const judgeAtLevel = (at: number): number => {
      const lowIndex = at < 0 ? -1 : before.pairOpen[at];
      const highIndex = at < 0 ? n : before.pairClose[at];
      const passes = passesTo(at);
      const openClasses = at < 0 ? 0 : before.pairOpenClasses[at];
      const closeClasses = at < 0 ? 0 : before.pairCloseClasses[at];
      // A window starts and ends at items whose innermost pair is `at`:
      // then no pair crosses its edges, and the pairs that span it are
      // `at` and those that hold it. The last such item at or before `x`,
      // or -1 for the start of the subject; the first after `x`, or n for
      // its end; or CLIMB, where there is none inside `at`.
      const freeAtOrBefore = (x: number) => {
        for (let i = upperBound(starts, x) - 1; i > lowIndex; i--) {
          if (innermost[i] === at) {
            return i;
          }
        }
        return at < 0 ? -1 : CLIMB;
      };
      const freeAfter = (x: number) => {
        for (let i = upperBound(starts, x); i < n && i <= highIndex; i++) {
          if (innermost[i] === at) {
            return i;
          }
        }
        return at < 0 ? n : CLIMB;
      };
      // The nearest item before `fromIndex` that leaves over an opener of
      // one of `classes` that a closer of the window may reach: one that a
      // pass over the window too left over (the pair whose interior it read
      // spans the window) and that no pair took out before the window. Or
      // -1.
      const leftoverBefore = (
        fromIndex: number,
        toIndex: number,
        classes: number,
      ) => {
        let nearest = -1;
        CLASS_BITS.forEach((itemClass, c) => {
          if (classes & itemClass) {
            nearest = Math.max(
              nearest,
              findLastAtLeast(before.leftovers[c], 0, fromIndex, toIndex),
            );
          }
        });
        return nearest;
      };
      // The nearest item at or after `toIndex` where a closer of one of
      // `classes` failed whose pass read the window too, or n.
      const closerFrom = (
        fromIndex: number,
        toIndex: number,
        classes: number,
      ) => {
        let nearest = n;
        CLASS_BITS.forEach((itemClass, c) => {
          if (classes & itemClass) {
            const found = findFirstBelow(
              before.closers[c],
              toIndex,
              n,
              Math.max(fromIndex, 0),
            );
            if (found >= 0) {
              nearest = Math.min(nearest, found);
            }
          }
        });
        return nearest;
      };
      const offsetOf = (i: number) =>
        i < 0 ? subject.start : i >= n ? subject.end : starts[i];
      const visibleClasses = (recorded: RecordedResolution) => {
        // What the window's passes leave over and fail on that a pass
        // outside its own pairs reads.
        let opens = 0;
        let closes = 0;
        for (const {
          itemClass,
          invocation,
          enclosure: taken,
        } of recorded.leftovers) {
          if (invocation < 0 && taken < 0) {
            opens |= itemClass;
          }
        }
        for (const {itemClass, invocation} of recorded.closers) {
          if (invocation < 0) {
            closes |= itemClass;
          }
        }
        return {closes, opens};
      };
      const windows: {
        fromIndex: number;
        from: number;
        to: number;
        recorded: RecordedResolution;
        opens: number;
      }[] = [];
      // The classes of the openers that the windows so far leave over, which
      // a closer in a later window may take.
      let windowLeftovers = 0;
      let r = 0;
      while (r < regions.length) {
        const [low] = regions[r];
        let high = regions[r++][1];
        let fromIndex = freeAtOrBefore(low);
        let toIndex = freeAfter(high);
        for (;;) {
          if (fromIndex === CLIMB || toIndex === CLIMB) {
            return CLIMB;
          }
          // The regions that the window reaches join it.
          while (r < regions.length && regions[r][0] < offsetOf(toIndex)) {
            high = Math.max(high, regions[r++][1]);
            if (high >= offsetOf(toIndex)) {
              toIndex = freeAfter(high);
              if (toIndex === CLIMB) {
                return CLIMB;
              }
            }
          }
          // A window that reaches back into an earlier one takes it in.
          while (
            windows.length > 0 &&
            offsetOf(fromIndex) < windows[windows.length - 1].to
          ) {
            fromIndex = Math.min(fromIndex, windows.pop()!.fromIndex);
            windowLeftovers = 0;
            for (const earlier of windows) {
              windowLeftovers |= earlier.opens;
            }
          }
          const from = offsetOf(fromIndex);
          const to = offsetOf(toIndex);
          const runsBefore = runsRead;
          const items = readItems(subject, from, to, own).filter(
            item => !isInLabel(item),
          );
          runsInWindows += runsRead - runsBefore;
          if (runsInWindows > 2 * (n + 1)) {
            return WHOLE;
          }
          const recorded = createRecorded();
          recordPasses(items, passes, recorded);
          const {closes, opens} = visibleClasses(recorded);
          // The edits of an earlier window may leave an opener over that the
          // state did not have: take that window in.
          if (windows.length > 0 && windowLeftovers & closes) {
            fromIndex = windows[windows.length - 1].fromIndex;
            continue;
          }
          // A closer that the window fails may take the opener of a pair
          // that spans the window, which changes that pair: judge above it.
          if (closes & openClasses) {
            return CLIMB;
          }
          // Or a leftover before the window: start at the nearest such
          // leftover, which is CLIMB where `at` does not hold it.
          const nearestLeftover = leftoverBefore(fromIndex, toIndex, closes);
          if (nearestLeftover >= 0) {
            fromIndex = freeAtOrBefore(starts[nearestLeftover]);
            continue;
          }
          // A leftover in the window may be taken by the closer of a pair
          // that spans it, or by a closer that failed after it: end after
          // the nearest such closer, which is CLIMB where `at` does not hold
          // it.
          if (opens & closeClasses) {
            return CLIMB;
          }
          const nearestCloser = closerFrom(fromIndex, toIndex, opens);
          if (nearestCloser < n) {
            toIndex = freeAfter(starts[nearestCloser]);
            continue;
          }
          const keys: ModelPair[] = [];
          for (
            let i = upperBound(before.openings, from - 1);
            i < before.openings.length && before.openings[i] < to;
            i++
          ) {
            keys.push(before.pairs[i]);
          }
          if (joinKeys(recorded.pairs) !== joinKeys(keys)) {
            return 0;
          }
          windows.push({from, fromIndex, opens, recorded, to});
          windowLeftovers |= opens;
          break;
        }
      }
      // A kept window has the pairs and the items it had: an edit is never
      // at a marker. What its items leave over and fail on may differ, so
      // each window takes off what its items added and adds its own.
      known.adopt = () => {
        for (const part of windows) {
          removeItems(
            before,
            upperBound(starts, part.from - 1),
            upperBound(starts, part.to - 1),
          );
          addRecorded(before, part.recorded);
        }
        return before;
      };
      return 1;
    };
    for (;;) {
      const result = judgeAtLevel(level);
      if (result === CLIMB) {
        level = pairParent[level];
        continue;
      }
      return result === WHOLE ? judgeWhole() : result === 1;
    }
  };

  // Whether each offset of a subject lies between a `[` and the `]` that
  // closes it, which may be on another line; an escaped bracket is text.
  // Brackets of an inline link or image, whose resource micromark read, do
  // not consult a definition, but brackets inside them may. Each pair adds
  // one at its `[` and takes one off after its `]`, so that one scan marks
  // the offsets that some pair holds, however deep pairs nest.
  const brackets = new Map<number, Uint8Array>();
  const isInBrackets = (subject: ModelSubject, offset: number) => {
    let marks = brackets.get(subject.index);
    if (!marks) {
      const size = subject.end - subject.start;
      positionsRead += size;
      const depth = new Int32Array(size + 1);
      const open: number[] = [];
      for (let i = subject.start; i < subject.end; i++) {
        if (markdown[i] === '\\') {
          i++;
        } else if (markdown[i] === '[') {
          open.push(i);
        } else if (markdown[i] === ']' && open.length > 0) {
          const start = open.pop()!;
          if (!isResourceStart[i + 1]) {
            depth[start - subject.start]++;
            depth[i + 1 - subject.start]--;
          }
        }
      }
      marks = new Uint8Array(size);
      let held = 0;
      for (let i = 0; i < size; i++) {
        held += depth[i];
        marks[i] = held > 0 ? 1 : 0;
      }
      brackets.set(subject.index, marks);
    }
    return marks[offset - subject.start] === 1;
  };
  const readsBaseBySubject = new Map<number, boolean>();
  const readsBase = (subject: ModelSubject) => {
    let reads = readsBaseBySubject.get(subject.index);
    if (reads === undefined) {
      reads =
        readPairs(subject, new Set()) ===
        (basePairs[subject.index] || []).sort().join(',');
      readsBaseBySubject.set(subject.index, reads);
    }
    return reads;
  };
  // The accepted edits of each subject, by the set and size they were read
  // at. Once the search accepts the edits of a kept judgement, which hold no
  // edit that a parse judges (see `needsParse`), the size is theirs and the
  // model of them is adopted.
  const acceptedBySubject = new Map<number, AcceptedEdits>();
  // Whether each offset of a subject lies in a run without whitespace that
  // holds a literal trigger. A reference writes only `&`, `#`, `x`, hex
  // digits and `;`, so it makes no trigger; but in such a run it may change
  // the literal (a domain that `&` ends), whose extent and the characters
  // it checks before it stay inside the run. The whitespace at its edges is
  // judged by a parse anyway.
  const literalRuns = new Map<number, Uint8Array>();
  const isInLiteralRun = (subject: ModelSubject, offset: number) => {
    let marks = literalRuns.get(subject.index);
    if (!marks) {
      const size = subject.end - subject.start;
      positionsRead += size;
      marks = new Uint8Array(size);
      let start = subject.start;
      for (let i = subject.start; i <= subject.end; i++) {
        if (
          i === subject.end ||
          (classifyCjkCode(markdown.codePointAt(i) ?? null) & WHITESPACE) !== 0
        ) {
          if (LITERAL_TRIGGERS.test(markdown.slice(start, i))) {
            marks.fill(1, start - subject.start, i - subject.start);
          }
          start = i + 1;
        }
      }
      literalRuns.set(subject.index, marks);
    }
    return marks[offset - subject.start] === 1;
  };
  // Whether a reference at `offset` may change what the model does not read:
  // ASCII punctuation; a space or a tab, which ends an autolink (`<ab:c d>`)
  // and a link destination (`[a](b c)`); or, where a literal autolink may
  // be, whitespace, which ends such a literal and may precede `www.`, or a
  // character of a run that may hold one. Control characters end them too,
  // but have no lossless reference, so the search never proposes them.
  const needsParse = (subject: ModelSubject, offset: number): boolean =>
    ASCII_PUNCTUATION.test(markdown[offset]) ||
    markdown[offset] === ' ' ||
    markdown[offset] === '\t' ||
    (hasLiterals &&
      ((classifyCjkCode(markdown.codePointAt(offset) ?? null) & WHITESPACE) !==
        0 ||
        isInLiteralRun(subject, offset)));
  const readAccepted = (
    subject: ModelSubject,
    accepted: ReadonlySet<number>,
  ): AcceptedEdits => {
    let known = acceptedBySubject.get(subject.index);
    if (known && known.edits === accepted && known.size === accepted.size) {
      return known;
    }
    if (
      known &&
      known.edits === accepted &&
      known.adopt &&
      known.keptSize === accepted.size
    ) {
      known = {
        edits: accepted,
        hasParsedEdit: false,
        size: accepted.size,
        state: known.adopt(),
      };
    } else {
      let hasParsedEdit = false;
      stateWork += accepted.size;
      for (const offset of accepted) {
        hasParsedEdit ||= needsParse(subject, offset);
      }
      known = {edits: accepted, hasParsedEdit, size: accepted.size};
    }
    acceptedBySubject.set(subject.index, known);
    return known;
  };
  // Whether a parse judges `proposed` in `subject`, or else, whether a
  // reference of it is escaped by a literal backslash before it, and so
  // reads as text: null, or that. An accepted edit is never escaped, as it
  // would not have read as before.
  const readGuards = (
    subject: ModelSubject,
    known: AcceptedEdits,
    proposed: readonly number[],
  ): boolean | null => {
    // A reference in place of whitespace, or in a run that may hold a
    // literal autolink, may make or end one. A reference in place of ASCII
    // punctuation may start or end other syntax (a link's `]`, a link
    // title's quote), which the model does not read; one in brackets may
    // change the label that a definition is matched with.
    if (!readsBase(subject) || known.hasParsedEdit) {
      return null;
    }
    for (const offset of proposed) {
      if (
        needsParse(subject, offset) ||
        (hasDefinitions && isInBrackets(subject, offset))
      ) {
        return null;
      }
    }
    for (const offset of proposed) {
      if (
        offset > 0 &&
        markdown[offset - 1] === '\\' &&
        isMarkerText[offset - 1]
      ) {
        return true;
      }
    }
    return false;
  };
  return {
    countItemsRead: () => itemsRead,
    countPositionsRead: () => positionsRead,
    countStateWork: () => stateWork,
    judge(subject, accepted, proposed) {
      const known = readAccepted(subject, accepted);
      const guard = readGuards(subject, known, proposed);
      if (guard === null) {
        return null;
      }
      const isKept = !guard && judgeIncrementally(subject, known, proposed);
      if (isKept) {
        known.keptSize = accepted.size + proposed.length;
      }
      return isKept;
    },
    judgeWhole(subject, accepted, proposed) {
      const guard = readGuards(
        subject,
        readAccepted(subject, accepted),
        proposed,
      );
      return guard === null
        ? null
        : !guard &&
            readPairs(subject, withEdits(accepted, proposed)) ===
              readPairs(subject, new Set());
    },
    readsBase,
  };
}
