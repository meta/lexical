/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import invariant from '@lexical/internal/invariant';
import {
  $getNodeByKey,
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  $isTextNode,
  type EditorState,
  type LexicalNode,
  type NodeKey,
  type NodeMap,
} from 'lexical';

import {
  keptStretches,
  setTextEnds,
  setTextStretches,
  snapToWords,
} from './Inline';
import {$isWrapper} from './Schema';

const __DEV__ = process.env.NODE_ENV !== 'production';

// Which characters of a line a commit kept. Lexical records, while the
// binding is attached, every change of a text node's text (a splice with its
// offsets, as typing and deleting make them; a split; a merge; a text set
// whole), every node the selection deletes, and every node inserted into or
// removed from an element's children, in order (EditorState#_textEdits).
// Replayed over the previous state, they give each character of each line
// its identity: an old character, or new.
//
// In flat storage, a node's type, format, link and segment key are
// attributes of its characters: which node holds a character is not its
// identity, its place in the line is.
//
// Invariant: an edit the record places exactly (a splice, a node the
// selection deletes) is written where it was made: the text it inserts is
// new, the text it deletes is gone. The old characters the record keeps in
// place, in order, pin the line; between two pins, what the record does not
// place (a node removed, made, replaced, moved, wrapped or unwrapped by app
// code or a transform; a text set whole, whose offsets are not known) is
// resolved by the diff a write makes without the record (see stretch): the
// text that left there and the text that arrived, aligned by their common
// start and end, in whole words, anchored at the caret. Why: transforms
// swap nodes without changing the line's text (a hashtag or keyword made of
// a part and made plain again, an entity grown by its neighbour's text, a
// range wrapped in a link), which says nothing of which characters the new
// nodes hold, and a guess per node lost characters next to equal text, so a
// peer's concurrent delete there came back. Where the record does not
// explain a line's text, the line has no identities, and the writer diffs it
// as before the record.
//
// Text entity transforms also record text they move into the previous node
// (a move) and text they remake in a node of another type (a retype): that
// text keeps its identities there, as an edit the record places does.

export type TextEditLog =
  NonNullable<EditorState['_textEdits']> extends WeakMap<NodeMap, infer L>
    ? L
    : never;

/**
 * A run of a node's characters by identity: characters `start` to `end` of
 * old node `key` (an old text node's text, or the one character of an old
 * line break or inline node), or, with `key` null, the new `text`.
 */
export type Segment = {
  readonly key: NodeKey | null;
  readonly start: number;
  readonly end: number;
  readonly text: string;
};

/** Characters of an old node. */
const OLD = 0;
/** Text a splice inserted (typed): new, where it was made. */
const NEW = 1;
/** Text that arrived otherwise (a node made, a text set): placed by place. */
const LOOSE = 2;
/** Characters whose text the record does not give. */
const UNKNOWN = 3;

/**
 * Characters `start` to `end` of `src` (an old node's key, or the id of text
 * inserted in this commit), whose text is `base`; `gone` once they left
 * their place, `dead` (text that arrived) once deleted (see stretch).
 */
type Run = {
  readonly src: string;
  readonly start: number;
  readonly end: number;
  readonly kind: number;
  readonly base: string;
  readonly gone?: true;
  readonly dead?: true;
  /**
   * Text a text set whole put in place of old characters (or of such text):
   * which characters it is, the record does not say (see stretch).
   */
  readonly set?: true;
  /**
   * The index of the move entry that split this run's history from the rest
   * of its node's, or joined it with another node's (see the move entry).
   */
  readonly moved?: number;
  /** The one character of an inline node (not a line break). */
  readonly atom?: true;
};

/**
 * A child of an element, in a list linked both ways: a node (`runs` null),
 * or the runs a node removed from there held, where it was.
 */
type Entry = {
  readonly key: NodeKey;
  runs: Run[] | null;
  prev: Entry | null;
  next: Entry | null;
  /** Taken out of its list (see adopt, takeBetween, dropGone). */
  out?: true;
  /** What the node removed from there held then (see adopt). */
  held?: Run[];
};

/** Element `key`'s children (see Entry), and its nodes by key. */
type List = {
  readonly key: NodeKey;
  head: Entry | null;
  tail: Entry | null;
  readonly live: Map<NodeKey, Entry>;
};

/**
 * A run of a line, in order: of node `node` (null for runs that left), at
 * offset `at` of its text, inside text node `owner` (null for what a removed
 * node held, then left `from` that removed node's place).
 */
type Item = {
  readonly run: Run;
  readonly node: NodeKey | null;
  readonly at: number;
  readonly owner: NodeKey | null;
  readonly from?: Entry;
};

/**
 * Text that left a stretch: at old position `at` (see resolve), `from` the
 * place of the removed node that held it (null: a text set replaced it);
 * `ord`, where it was in the line's items.
 */
type Left = {
  readonly run: Run;
  readonly from: Entry | null;
  at: number;
  readonly ord: number;
};

/**
 * A stretch of a line between two pins (see resolve): its runs in the new
 * line (`live`, with text that arrived and was deleted), the text that left
 * it, in order, and the text that arrived there and left again in this
 * commit (`passed`, after the old position `at`), which is neither state's
 * but was there between the old characters around it (see align's `sure`).
 */
type Stretch = {
  live: Item[];
  left: Left[];
  passed: {readonly text: string; readonly at: number; readonly ord: number}[];
  unknown?: true;
};

/**
 * Characters `a` to `a + n` of the text that arrived in a stretch (in line
 * order) are characters `o` to `o + n` of the text that left it.
 */
type Block = {readonly a: number; readonly n: number; readonly o: number};

/** Item `x` of what arrived: its characters `a` to `a + n`. */
type Span = {readonly a: number; readonly n: number; readonly x: Item};

type Kind = 'text' | 'break' | 'wrapper' | 'atom' | 'block';

const OBJ = '\ufffc';
const UNKNOWN_RUN: Run = {base: '', end: 0, kind: UNKNOWN, src: '', start: 0};

/** How a node is laid out in a line, as $pushInline (Inline.ts) lays it. */
function kindOf(node: LexicalNode | null | undefined): Kind | null {
  if (node === null || node === undefined) {
    return null;
  }
  if ($isTextNode(node)) {
    return 'text';
  }
  if ($isLineBreakNode(node)) {
    return 'break';
  }
  if ($isElementNode(node)) {
    return !node.isInline() ? 'block' : $isWrapper(node) ? 'wrapper' : 'atom';
  }
  return $isDecoratorNode(node) && !node.isInline() ? 'block' : 'atom';
}

const textOf = (r: Run): string => r.base.slice(r.start, r.end);
const goneOf = (r: Run): Run => (r.gone || r.dead ? r : {...r, gone: true});
const length = (r: Run): number => r.end - r.start;
/** Whether run `r` is text in its place (not gone, not deleted). */
const isLive = (r: Run): boolean => r.gone !== true && r.dead !== true;
/**
 * Run `r` deleted by an edit the record places: gone, but text that arrived
 * stays as deleted, so that what it stood for is deleted (see stretch).
 */
const deadOf = (r: Run): Run[] =>
  !isLive(r) ? [r] : r.kind === LOOSE ? [{...r, dead: true}] : [];

/** Runs `runs` cut at live offset `at` (a run gone there goes first). */
function cut(runs: readonly Run[], at: number): [Run[], Run[]] {
  const a: Run[] = [];
  const b: Run[] = [];
  let pos = 0;
  for (const r of runs) {
    if (!isLive(r)) {
      (pos <= at && b.length === 0 ? a : b).push(r);
      continue;
    }
    const n = length(r);
    if (pos + n <= at) {
      a.push(r);
    } else if (pos >= at) {
      b.push(r);
    } else {
      a.push({...r, end: r.start + at - pos});
      b.push({...r, start: r.start + at - pos});
    }
    pos += n;
  }
  return [a, b];
}

const liveText = (runs: readonly Run[]): string => {
  let text = '';
  for (const r of runs) {
    if (isLive(r)) {
      text += textOf(r);
    }
  }
  return text;
};

/** The identity of run `r` as a Segment. */
const segmentOf = (r: Run): Segment =>
  r.kind === OLD
    ? {end: r.end, key: r.src, start: r.start, text: textOf(r)}
    : {end: length(r), key: null, start: 0, text: textOf(r)};

/** Append, joining with the last segment where they continue each other. */
function push(out: Segment[], s: Segment): void {
  if (s.end <= s.start) {
    return;
  }
  const last = out[out.length - 1];
  if (last !== undefined && last.key === s.key) {
    if (s.key === null) {
      const text = last.text + s.text;
      out[out.length - 1] = {end: text.length, key: null, start: 0, text};
      return;
    }
    if (last.end === s.start) {
      out[out.length - 1] = {
        end: s.end,
        key: s.key,
        start: last.start,
        text: last.text + s.text,
      };
      return;
    }
  }
  out.push(s);
}

/**
 * Blocks `keep` (in order, see Block), with the parts of blocks `more` (in
 * order) that lie between two of them, or one and an end, in both texts.
 */
function within(keep: readonly Block[], more: readonly Block[]): Block[] {
  const out: Block[] = [];
  let m = 0;
  for (let i = 0; i <= keep.length; i++) {
    const prev = i > 0 ? keep[i - 1] : null;
    const next = i < keep.length ? keep[i] : null;
    if (prev !== null) {
      out.push(prev);
    }
    const a0 = prev === null ? 0 : prev.a + prev.n;
    const o0 = prev === null ? 0 : prev.o + prev.n;
    const a1 = next === null ? Infinity : next.a;
    const o1 = next === null ? Infinity : next.o;
    while (m < more.length && more[m].a + more[m].n <= a0) {
      m++;
    }
    for (let j = m; j < more.length && more[j].a < a1; j++) {
      const b = more[j];
      // Character `x` of what arrived is character `x + shift` of `d`.
      const shift = b.o - b.a;
      const lo = Math.max(b.a, a0, o0 - shift);
      const hi = Math.min(b.a + b.n, a1, o1 - shift);
      if (hi > lo) {
        out.push({a: lo, n: hi - lo, o: lo + shift});
      }
    }
  }
  return out;
}

/** Unlink `e` from `list`. */
function unlink(list: List, e: Entry): void {
  if (e.out === true) {
    return;
  }
  e.out = true;
  if (e.prev === null) {
    list.head = e.next;
  } else {
    e.prev.next = e.next;
  }
  if (e.next === null) {
    list.tail = e.prev;
  } else {
    e.next.prev = e.prev;
  }
}

/** Link `e` into `list` before `at` (at the end when null). */
function linkBefore(list: List, e: Entry, at: Entry | null): void {
  e.next = at;
  e.prev = at === null ? list.tail : at.prev;
  if (e.prev === null) {
    list.head = e;
  } else {
    e.prev.next = e;
  }
  if (at === null) {
    list.tail = e;
  } else {
    at.prev = e;
  }
}

/**
 * The identities of the characters of a commit's lines (see the header),
 * replayed from its record over the previous state, inside a read of the new
 * state; each line resolved on first use.
 */
export class TextReplay {
  /** Each text node the record names: its runs, null where not known. */
  private readonly texts = new Map<NodeKey, Run[] | null>();
  /**
   * Each element whose children the record changed: its children, with what
   * a node removed from there held where it was; null where not known.
   */
  private readonly lists = new Map<NodeKey, List | null>();
  /** Where what each removed node held was left (see dropGone). */
  private readonly goneAt = new Map<NodeKey, [List, Entry][]>();
  /** The parent of each node the record inserted or removed (null: none). */
  private readonly parents = new Map<NodeKey, NodeKey | null>();
  /** Nodes the selection removed with what they held: a delete. */
  private readonly deleted = new Set<NodeKey>();
  /** Each line's (or inline container's) identities (see resolve). */
  private readonly resolved = new Map<
    NodeKey,
    Map<NodeKey, Segment[]> | null
  >();
  /** Old characters in a node of the new state, sorted (see notLive). */
  private live: Map<string, [number, number][]> | null = null;
  /** An entry this binding does not know: nothing is known. */
  private broken = false;
  private ids = 0;
  /** The index of the entry being replayed. */
  private at = 0;
  /** Moves replayed as the text sets they stand for (see the move entry). */
  private readonly unsafe = new Set<number>();
  /** The moves found unsafe in this replay (see the move entry). */
  private restart: number[] | null = null;

  /** The previous state's nodes, by key. */
  private readonly prevMap: NodeMap;

  constructor(
    log: TextEditLog | null,
    /** The state before this update. */
    private readonly prevState: EditorState,
    /** The caret of the new state, where it is in a text node. */
    private readonly caret: {key: NodeKey; offset: number} | null,
    private readonly composing: boolean,
  ) {
    this.prevMap = prevState._nodeMap;
    if (log !== null) {
      // Where a text set reaches text whose history a move split or joined,
      // or a removed node still holds such text at the end (set text aligns
      // with its text whole or not at all, see stretch), the replay starts
      // over with that move as the text sets it stands for (see the move
      // entry): at most once per move.
      for (;;) {
        for (let i = 0; i < log.length && this.restart === null; i++) {
          this.at = i;
          this.apply(log[i]);
        }
        if (this.restart === null) {
          // (Only where the node it was removed from is in the new state:
          // what a node removed with it held is aligned with that node.)
          const moves = new Set<number>();
          for (const gone of this.goneAt.values()) {
            for (const [list, entry] of gone) {
              const owner = $getNodeByKey(list.key);
              if (
                entry.out !== true &&
                entry.runs !== null &&
                this.lists.get(list.key) === list &&
                owner !== null &&
                owner.isAttached()
              ) {
                this.marks(entry.runs).forEach(m => moves.add(m));
              }
            }
          }
          if (moves.size > 0) {
            this.restart = [...moves];
          }
        }
        const moves = this.restart;
        if (moves === null) {
          break;
        }
        for (const m of moves) {
          this.unsafe.add(m);
        }
        this.restart = null;
        this.texts.clear();
        this.lists.clear();
        this.goneAt.clear();
        this.parents.clear();
        this.deleted.clear();
        this.broken = false;
        this.ids = 0;
      }
    }
  }

  /**
   * The identities of the characters of text node `key` of the new state (or
   * of the one character of a line break or inline node), in order; null
   * where the record does not explain the text of its line.
   */
  idsOf(key: NodeKey): readonly Segment[] | null {
    const node = $getNodeByKey(key);
    let holder = node === null ? null : node.getParent();
    while (holder !== null && $isWrapper(holder)) {
      holder = holder.getParent();
    }
    if (holder === null) {
      return null;
    }
    const at = holder.getKey();
    let map = this.resolved.get(at);
    if (map === undefined) {
      map = this.broken ? null : this.resolve(at);
      this.resolved.set(at, map);
    }
    return map === null ? null : (map.get(key) ?? []);
  }

  private apply(e: TextEditLog[number]): void {
    if (this.restart !== null) {
      return;
    }
    switch (e[0]) {
      case 'splice': {
        const [, key, offset, del, text, before] = e;
        const runs = this.text(key, before);
        if (runs !== null) {
          const [a, rest] = cut(runs, offset);
          const [mid, b] = cut(rest, del);
          // What it deleted is gone; text that left there before stays.
          const out = a.concat(mid.flatMap(deadOf));
          if (text !== '') {
            out.push(this.inserted(text, NEW));
          }
          this.texts.set(key, out.concat(b));
        }
        break;
      }
      case 'split': {
        const [, key, parts, starts, before] = e;
        let runs = this.text(key, before);
        if (!parts.includes(key)) {
          // Segmented: replaced by its parts.
          this.texts.set(key, []);
        }
        parts.forEach((part, i) => {
          if (runs === null || i + 1 === parts.length) {
            this.texts.set(part, runs);
          } else {
            const [a, b] = cut(runs, starts[i + 1] - starts[i]);
            this.texts.set(part, a);
            runs = b;
          }
        });
        break;
      }
      case 'merge': {
        const [, key, target, isBefore, text, targetText] = e;
        const a = this.text(key, text);
        const b = this.text(target, targetText);
        // What left from between the two is between their texts now.
        const between = isBefore
          ? this.takeBetween(target, key)
          : this.takeBetween(key, target);
        this.texts.set(
          key,
          a === null || b === null
            ? null
            : isBefore
              ? b.concat(between, a)
              : a.concat(between, b),
        );
        this.texts.set(target, []);
        break;
      }
      case 'set': {
        // Offsets not known: all of its text left, and the new text arrived
        // in its place (see stretch).
        const [, key, before, after] = e;
        let runs = this.text(key, before);
        if (runs !== null) {
          const moves = this.marks(runs);
          if (moves.length > 0) {
            this.restart = moves;
            break;
          }
          if (runs.some(r => r.dead === true)) {
            runs = this.compose(runs);
          }
          const out = runs.map(goneOf);
          if (after !== '') {
            // In place of old characters (or of text a set put in their
            // place), it may be (some of) them, or old characters that left
            // next to it; in place of new text only (a node made and set),
            // it is new, as made.
            const run = this.inserted(after, LOOSE);
            out.push(
              runs.some(r => isLive(r) && (r.kind === OLD || r.set === true))
                ? {...run, set: true}
                : run,
            );
          }
          this.texts.set(key, out);
        }
        break;
      }
      case 'delete':
        // What it holds is deleted where it is (see collect), as a splice
        // deletes.
        this.deleted.add(e[1]);
        break;
      case 'move': {
        // The first characters of a node moved to the end of its previous
        // sibling (an entity grown over the text after it): where both texts
        // are the ones replayed, the moved runs keep their identities there.
        // Text that left a node earlier in the commit, and what arrived in
        // its place (a set, typed text deleted again), are aligned with each
        // other when that node is set whole again (see compose and stretch),
        // and set text aligns with a removed node's text whole or not at all
        // (see stretch). Where the move splits such a history between the two
        // nodes, or joins two, those runs are marked with it, wherever they
        // go; where a text set later in the commit reaches one, or a removed
        // node still holds one at the end, the replay starts over with the
        // move as the two text sets it stands for.
        const [, from, to, count, fromText, toText] = e;
        const a = this.text(to, toText);
        const b = this.text(from, fromText);
        if (a !== null && b !== null && !this.unsafe.has(this.at)) {
          const [head, rest] = cut(b, count);
          const ofHistory = (r: Run) => !isLive(r) || r.set === true;
          const at = this.at;
          const mark =
            head.some(ofHistory) && (rest.some(ofHistory) || a.some(ofHistory))
              ? (runs: Run[]) =>
                  runs.map(r => (ofHistory(r) ? {...r, moved: at} : r))
              : (runs: Run[]) => runs;
          this.texts.set(to, mark(a).concat(mark(head)));
          this.texts.set(from, mark(rest));
          break;
        }
        this.apply(['set', to, toText, toText + fromText.slice(0, count)]);
        if (count < fromText.length) {
          // (Where it moved all of them, the node's removal follows.)
          this.apply(['set', from, fromText, fromText.slice(count)]);
        }
        break;
      }
      case 'retype': {
        const [, prev, next, text] = e;
        this.retype(prev, next, text);
        break;
      }
      case 'attach': {
        const [, key, parent, prev, next, text] = e;
        if (text !== null) {
          this.text(key, text);
        } else if (this.kindNow(key) === 'block') {
          // A block's place in its container is no character of a line.
          break;
        }
        this.parents.set(key, parent);
        const list = this.list(parent);
        if (list !== null) {
          this.attach(list, key, prev, next);
        }
        break;
      }
      case 'detach': {
        const [, key, parent] = e;
        this.parents.set(key, null);
        if (!this.texts.has(key) && this.kindNow(key) === 'block') {
          break;
        }
        const list = this.list(parent);
        if (list === null) {
          break;
        }
        const entry = list.live.get(key);
        if (entry === undefined) {
          this.lists.set(parent, null);
          break;
        }
        const runs: Run[] = [];
        this.collect(key, runs);
        entry.held = runs;
        entry.runs = runs.map(goneOf);
        list.live.delete(key);
        const gone = this.goneAt.get(key);
        if (gone === undefined) {
          this.goneAt.set(key, [[list, entry]]);
        } else {
          gone.push([list, entry]);
        }
        break;
      }
      default:
        this.broken = true;
    }
  }

  /**
   * Put node `key` between its siblings `prev` and `next` in `list`: where
   * it was, if it was removed from there (a node cut and put back, as a
   * split does), else right after `prev` (or before `next`).
   */
  private attach(
    list: List,
    key: NodeKey,
    prev: NodeKey | null,
    next: NodeKey | null,
  ): void {
    const lo = prev === null ? null : (list.live.get(prev) ?? null);
    const hi = next === null ? null : (list.live.get(next) ?? null);
    if ((prev !== null && lo === null) || (next !== null && hi === null)) {
      this.lists.set(list.key, null);
      return;
    }
    for (
      let e = lo === null ? list.head : lo.next;
      e !== null && e !== hi;
      e = e.next
    ) {
      if (e.key === key && e.runs !== null) {
        e.runs = null;
        list.live.set(key, e);
        this.dropGone(key);
        return;
      }
    }
    this.dropGone(key);
    const entry: Entry = {key, next: null, prev: null, runs: null};
    linkBefore(list, entry, lo !== null ? lo.next : hi);
    list.live.set(key, entry);
    this.adopt(list, entry);
  }

  /**
   * A node put where nodes were removed (a node swapped for another, as a
   * transform makes one again): where all the text it holds arrived (made)
   * and is the text the nodes removed right around it held, it holds what
   * they held, from now on, so that what the commit does to it later keeps
   * those characters (the rest is resolved at the end, see stretch).
   */
  private adopt(list: List, entry: Entry): void {
    const nodes: NodeKey[] = [];
    if (!this.madeTexts(entry.key, nodes)) {
      return;
    }
    const sizes = nodes.map(k => liveText(this.texts.get(k)!).length);
    const arrived = nodes.map(k => liveText(this.texts.get(k)!)).join('');
    if (arrived === '') {
      return;
    }
    const before: Entry[] = [];
    for (let e = entry.prev; e !== null && e.runs !== null; e = e.prev) {
      before.unshift(e);
    }
    const after: Entry[] = [];
    for (let e = entry.next; e !== null && e.runs !== null; e = e.next) {
      after.push(e);
    }
    for (const around of [before.concat(after), after, before]) {
      if (around.length === 0 || around.some(e => e.held === undefined)) {
        continue;
      }
      let held: Run[] = around.flatMap(e => e.held!);
      if (held.some(r => r.kind === UNKNOWN) || liveText(held) !== arrived) {
        continue;
      }
      nodes.forEach((k, i) => {
        if (i + 1 === nodes.length) {
          this.texts.set(k, held);
        } else {
          const [a, b] = cut(held, sizes[i]);
          this.texts.set(k, a);
          held = b;
        }
      });
      for (const e of around) {
        unlink(list, e);
        e.runs = [];
      }
      return;
    }
  }

  /**
   * The text nodes node `key` holds (itself, or below it), into `out`, when
   * all of their text arrived (made, set); false otherwise.
   */
  private madeTexts(key: NodeKey, out: NodeKey[]): boolean {
    const runs = this.texts.get(key);
    if (runs !== undefined) {
      if (runs === null || runs.some(r => isLive(r) && r.kind !== LOOSE)) {
        return false;
      }
      out.push(key);
      return true;
    }
    const list = this.lists.get(key);
    if (list === undefined || list === null || this.kindNow(key) === 'text') {
      return false;
    }
    for (let e = list.head; e !== null; e = e.next) {
      if (e.runs !== null || !this.madeTexts(e.key, out)) {
        return false;
      }
    }
    return true;
  }

  /** Text inserted in this commit, of kind `kind` (NEW or LOOSE). */
  private inserted(text: string, kind: number): Run {
    return {
      base: text,
      end: text.length,
      kind,
      src: '\u0000' + this.ids++,
      start: 0,
    };
  }

  /**
   * The runs of a text node about to be set whole again, where text that
   * arrived there (a set, a node made) was deleted since by an edit the
   * record places: the text that arrived is aligned with the text that left
   * the node before it, as a stretch is (see stretch), the old characters
   * the deleted text is aligned with are deleted, and the deleted text is
   * dropped. Why: once the set replaces it, where it was is not known, and
   * which old characters it stood for could not be told any more (a caret
   * delete in a set's text, then a set: the delete came back).
   */
  private compose(runs: readonly Run[]): Run[] {
    let d = '';
    let s = '';
    for (const r of runs) {
      if (r.gone === true ? r.kind !== LOOSE : r.kind === LOOSE) {
        if (r.gone === true) {
          d += textOf(r);
        } else {
          s += textOf(r);
        }
      }
    }
    const {prefix, suffix} = setTextEnds(d, s, -1, this.composing);
    // The characters of `d` aligned with deleted text, in order.
    const cuts: [number, number][] = [];
    for (let i = 0, pos = 0; i < runs.length; i++) {
      const r = runs[i];
      if (r.gone === true || r.kind !== LOOSE) {
        continue;
      }
      const n = length(r);
      if (r.dead === true) {
        const e = Math.min(pos + n, prefix);
        if (e > pos) {
          cuts.push([pos, e]);
        }
        const b = Math.max(pos, s.length - suffix);
        if (pos + n > b) {
          cuts.push([b - s.length + d.length, pos + n - s.length + d.length]);
        }
      }
      pos += n;
    }
    const out: Run[] = [];
    let c = 0;
    for (let i = 0, pos = 0; i < runs.length; i++) {
      const r = runs[i];
      if (r.dead === true) {
        continue;
      }
      if (r.gone !== true || r.kind === LOOSE) {
        out.push(r);
        continue;
      }
      const n = length(r);
      let at = pos;
      while (c < cuts.length && cuts[c][1] <= at) {
        c++;
      }
      for (let k = c; k < cuts.length && cuts[k][0] < pos + n; k++) {
        if (cuts[k][0] > at) {
          out.push({
            ...r,
            end: r.start + cuts[k][0] - pos,
            start: r.start + at - pos,
          });
        }
        at = Math.max(at, cuts[k][1]);
      }
      if (at < pos + n) {
        out.push({...r, start: r.start + at - pos});
      }
      pos += n;
    }
    return out;
  }

  /** A node's layout, from the previous state, else from the new one. */
  private kindNow(key: NodeKey): Kind | null {
    const old = this.prevMap.get(key);
    return old !== undefined ? this.oldKind(old) : kindOf($getNodeByKey(key));
  }

  /**
   * The layout of a node of the previous state, read in that state: a class
   * may compute `isInline()` from its latest version, which a node this
   * update removed no longer has.
   */
  private oldKind(node: LexicalNode | undefined): Kind | null {
    return node === undefined ? null : this.prevState.read(() => kindOf(node));
  }

  /** An old text node's runs: its whole old text. Null if not a text node. */
  private oldRuns(key: NodeKey): Run[] | null {
    const node = this.prevMap.get(key);
    if (!$isTextNode(node)) {
      return null;
    }
    const base = node.__text;
    return base === ''
      ? []
      : [{base, end: base.length, kind: OLD, src: key, start: 0}];
  }

  /**
   * The runs of text node `key` where the record says its text is `text`:
   * as replayed so far, else its old text, else (a node made in this
   * commit) that text arrived; null when not known, or not that text.
   */
  private text(key: NodeKey, text: string): Run[] | null {
    let runs = this.texts.get(key);
    if (runs === undefined) {
      if (this.prevMap.has(key)) {
        const old = this.oldRuns(key);
        runs = old !== null && liveText(old) === text ? old : null;
      } else {
        runs = text === '' ? [] : [this.inserted(text, LOOSE)];
      }
      this.texts.set(key, runs);
    } else if (runs !== null && liveText(runs) !== text) {
      runs = null;
      this.texts.set(key, null);
    }
    return runs;
  }

  /** An element's children, from the previous state on first use. */
  private list(key: NodeKey): List | null {
    let list = this.lists.get(key);
    if (list === undefined) {
      list = {head: null, key, live: new Map(), tail: null};
      const old = this.prevMap.get(key);
      if ($isElementNode(old)) {
        for (let c = old.__first; c !== null; ) {
          const node = this.prevMap.get(c);
          if (node === undefined) {
            list = null;
            break;
          }
          const e: Entry = {key: c, next: null, prev: null, runs: null};
          linkBefore(list, e, null);
          list.live.set(c, e);
          c = node.__next;
        }
      }
      this.lists.set(key, list);
    }
    return list;
  }

  /**
   * The moves not yet replayed as text sets that split or joined history
   * runs `runs` hold (see the move entry).
   */
  private marks(runs: readonly Run[]): number[] {
    const moves: number[] = [];
    for (const r of runs) {
      if (r.moved !== undefined && !this.unsafe.has(r.moved)) {
        moves.push(r.moved);
      }
    }
    return moves;
  }

  /**
   * Node `next` replaced node `prev`, remade with its text `text` (a retype,
   * see the record): where all of next's text arrived (made) and is what
   * prev held when it was removed, next holds what prev held, from now on,
   * and nothing of it is gone where prev was. Otherwise nothing changes (the
   * rest is resolved at the end, see stretch).
   */
  private retype(prev: NodeKey, next: NodeKey, text: string): void {
    const runs = this.texts.get(next);
    const gone = this.goneAt.get(prev);
    if (
      runs === undefined ||
      runs === null ||
      gone === undefined ||
      liveText(runs) !== text ||
      runs.some(r => isLive(r) && r.kind !== LOOSE)
    ) {
      return;
    }
    const [list, entry] = gone[gone.length - 1];
    const held = entry.held;
    if (
      held === undefined ||
      entry.runs === null ||
      entry.out === true ||
      liveText(held) !== text ||
      held.some(r => r.kind === UNKNOWN)
    ) {
      return;
    }
    this.texts.set(next, held);
    unlink(list, entry);
    entry.runs = [];
  }

  /**
   * A node put back somewhere: what it held is no longer gone where it was
   * removed (it holds it where it is).
   */
  private dropGone(key: NodeKey): void {
    const gone = this.goneAt.get(key);
    if (gone !== undefined) {
      for (const [list, entry] of gone) {
        if (entry.runs !== null) {
          unlink(list, entry);
          entry.runs = [];
        }
      }
      this.goneAt.delete(key);
    }
  }

  /**
   * The runs gone from between siblings `a` and `b` (`a` first) in their
   * parent's children, taken out of there (see the merge entry).
   */
  private takeBetween(a: NodeKey, b: NodeKey): Run[] {
    const p = this.parents.get(a);
    const old = this.prevMap.get(a);
    const parent =
      p !== undefined ? p : old === undefined ? null : old.__parent;
    const list = parent === null ? undefined : this.lists.get(parent);
    const lo = list ? list.live.get(a) : undefined;
    const hi = list ? list.live.get(b) : undefined;
    if (!list || lo === undefined || hi === undefined) {
      return [];
    }
    const out: Run[] = [];
    const taken: Entry[] = [];
    for (let e = lo.next; e !== hi; e = e.next) {
      if (e === null || e.runs === null) {
        return [];
      }
      taken.push(e);
    }
    for (const e of taken) {
      for (const r of e.runs!) {
        out.push(r);
      }
      unlink(list, e);
      e.runs = [];
    }
    return out;
  }

  /** The one character of a line break or inline node `key`, as it is. */
  private atom(key: NodeKey, kind: Kind | null): Run {
    const old = this.oldKind(this.prevMap.get(key));
    if (old !== null && old === kind) {
      return kind === 'break'
        ? {base: '\n', end: 1, kind: OLD, src: key, start: 0}
        : {atom: true, base: OBJ, end: 1, kind: OLD, src: key, start: 0};
    }
    // Made in this commit: a line break may be a line feed made again (see
    // stretch), any other node is new.
    return kind === 'break'
      ? this.inserted('\n', LOOSE)
      : {...this.inserted(OBJ, NEW), atom: true};
  }

  /**
   * The runs node `key` holds now (wrappers flattened), during the replay:
   * of a node the selection deleted, deleted (see deadOf).
   */
  private collect(key: NodeKey, out: Run[]): void {
    if (this.deleted.has(key)) {
      const all: Run[] = [];
      this.deleted.delete(key);
      this.collect(key, all);
      this.deleted.add(key);
      for (const r of all) {
        for (const d of deadOf(r)) {
          out.push(d);
        }
      }
      return;
    }
    const kind = this.kindNow(key);
    if (this.texts.has(key) || kind === 'text') {
      const runs = this.texts.has(key)
        ? this.texts.get(key)!
        : this.oldRuns(key);
      if (runs === null) {
        out.push(UNKNOWN_RUN);
      } else {
        for (const r of runs) {
          out.push(r);
        }
      }
    } else if (
      this.prevMap.has(key) &&
      (kind === 'break' || kind === 'atom' || kind === 'block')
    ) {
      out.push(this.atom(key, kind));
    } else {
      // A wrapper, or a node made in this commit: what it holds, as far as
      // the record says (nothing, for a line break or inline node made and
      // removed again).
      const list = kind === 'wrapper' ? this.list(key) : this.lists.get(key);
      if (list === undefined && !this.prevMap.has(key)) {
        return;
      }
      if (list === null || list === undefined) {
        out.push(UNKNOWN_RUN);
        return;
      }
      for (let e = list.head; e !== null; e = e.next) {
        if (e.runs !== null) {
          for (const r of e.runs) {
            out.push(r);
          }
        } else {
          this.collect(e.key, out);
        }
      }
    }
  }

  /**
   * The runs of line (or inline container) `key` in the new state, those
   * that left where they left, into `out`; false where the record does not
   * explain them (its children are not the ones it replays, or a text
   * node's text is not the one it gives).
   */
  private flatten(key: NodeKey, out: Item[]): boolean {
    const node = $getNodeByKey(key);
    if (!$isElementNode(node)) {
      return false;
    }
    const children = node.getChildren();
    const list = this.lists.get(key);
    if (list === null) {
      return false;
    }
    let entries: (Entry | NodeKey)[];
    if (list === undefined) {
      entries = children.map(c => c.getKey());
    } else {
      entries = [];
      let k = 0;
      for (let e = list.head; e !== null; e = e.next) {
        if (e.runs === null) {
          if (k >= children.length || children[k].getKey() !== e.key) {
            return false;
          }
          k++;
          entries.push(e.key);
        } else {
          entries.push(e);
        }
      }
      if (k !== children.length) {
        return false;
      }
    }
    for (const x of entries) {
      if (typeof x !== 'string') {
        for (const run of x.runs!) {
          out.push({at: 0, from: x, node: null, owner: null, run});
        }
        continue;
      }
      const child = $getNodeByKey(x)!;
      const kind = kindOf(child);
      if (kind === 'text') {
        const text = child.getTextContent();
        let runs = this.texts.get(x);
        if (runs === undefined) {
          runs = this.prevMap.has(x)
            ? this.oldRuns(x)
            : text === ''
              ? []
              : [this.inserted(text, LOOSE)];
        }
        if (runs === null || liveText(runs) !== text) {
          return false;
        }
        let at = 0;
        for (const run of runs) {
          if (!isLive(run)) {
            out.push({at: 0, node: null, owner: x, run});
          } else {
            out.push({at, node: x, owner: x, run});
            at += length(run);
          }
        }
      } else if (kind === 'wrapper') {
        if (!this.flatten(x, out)) {
          return false;
        }
      } else {
        out.push({at: 0, node: x, owner: null, run: this.atom(x, kind)});
      }
    }
    return true;
  }

  /**
   * Where each old text node, line break and inline node of line `key`
   * started in its old content (wrappers flattened), by key.
   */
  private oldLayout(key: NodeKey): Map<string, number> {
    const out = new Map<string, number>();
    let pos = 0;
    const walk = (k: NodeKey) => {
      const el = this.prevMap.get(k);
      if (!$isElementNode(el)) {
        return;
      }
      for (let c = el.__first; c !== null; ) {
        const node = this.prevMap.get(c);
        if (node === undefined) {
          return;
        }
        const kind = this.oldKind(node);
        out.set(c, pos);
        if (kind === 'text') {
          pos += (node as LexicalNode & {__text: string}).__text.length;
        } else if (kind === 'wrapper') {
          walk(c);
        } else {
          pos += 1;
        }
        c = node.__next;
      }
    };
    walk(key);
    return out;
  }

  /**
   * The identities of the characters of line `key` (see the header): the
   * old characters in place, in order, are theirs, and each stretch between
   * them is resolved by place (see stretch): what arrived there in the new
   * line, and what left from between them in the old line (text that left
   * and was no old character of the line, where it left).
   */
  private resolve(key: NodeKey): Map<NodeKey, Segment[]> | null {
    const items: Item[] = [];
    if (!this.flatten(key, items)) {
      return null;
    }
    const layout = this.oldLayout(key);
    const oldAt = (r: Run): number => {
      const at = r.kind === OLD ? layout.get(r.src) : undefined;
      return at === undefined ? -1 : at + r.start;
    };
    // The old characters in place: the live old runs of this line, in
    // order in both (each a stretch's end).
    const anchors: number[] = [];
    const ends: number[] = [];
    let last = -1;
    items.forEach((x, k) => {
      const at = x.node === null ? -1 : oldAt(x.run);
      if (at > last) {
        anchors.push(k);
        ends.push(at);
        last = at + length(x.run) - 1;
      }
    });
    const stretches: Stretch[] = [];
    for (let s = 0; s <= anchors.length; s++) {
      stretches.push({left: [], live: [], passed: []});
    }
    // The stretch an old position is in.
    const byOld = (at: number): number => {
      let lo = 0;
      let hi = ends.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ends[mid] <= at) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      return lo;
    };
    let s = 0;
    let lastOld = -1;
    items.forEach((x, k) => {
      if (s < anchors.length && anchors[s] === k) {
        s++;
        lastOld = ends[s - 1];
        return;
      }
      if (x.run.kind === UNKNOWN) {
        stretches[s].unknown = true;
      } else if (x.node !== null || x.run.dead === true) {
        stretches[s].live.push(x);
      } else if (x.run.gone === true && x.run.kind === LOOSE) {
        stretches[s].passed.push({
          at: lastOld + 0.5,
          ord: k,
          text: textOf(x.run),
        });
      } else if (x.run.gone === true && x.run.kind !== LOOSE) {
        // (Text that arrived and left again in this commit is neither
        // state's: what it stood for left too.)
        for (const run of this.notLive(x.run)) {
          const at = oldAt(run);
          const t = at < 0 ? s : byOld(at);
          if (t === s && at >= 0) {
            lastOld = at;
          }
          stretches[t].left.push({
            at: at < 0 ? lastOld : at,
            from: x.from ?? null,
            ord: k,
            run,
          });
        }
      }
    });
    const out = new Map<NodeKey, Segment[]>();
    const add = (node: NodeKey, seg: Segment) => {
      let list = out.get(node);
      if (list === undefined) {
        list = [];
        out.set(node, list);
      }
      push(list, seg);
    };
    s = 0;
    items.forEach((x, k) => {
      if (s < anchors.length && anchors[s] === k) {
        if (!this.stretch(stretches[s], add)) {
          s = -Infinity;
        }
        add(x.node!, segmentOf(x.run));
        s++;
      }
    });
    if (s < 0 || !this.stretch(stretches[anchors.length], add)) {
      return null;
    }
    return out;
  }

  /**
   * Resolve a stretch of a line between two pins (old characters the record
   * keeps in place, in order): the text that left it (a removed node's
   * text, the text a set replaced) and the text that arrived there (a text
   * set, a node made), each in line order, are aligned by the diff a write
   * makes without the record (see diffStrings and snapToWords: their common
   * start and end, in whole words, anchored at the caret where it is in the
   * text aligned and in a node that was there before; a node made in this
   * commit has the caret where whatever made it put it). What it aligns
   * keeps its identity; the rest that arrived is new, and the rest that
   * left is deleted. Invariants:
   * 1. Only pins split a line. Text an edit the record places inserted
   *    (typed) is new where it is, and old characters it deleted are gone:
   *    neither is in a stretch's text, nor splits it (the record does not
   *    order a node made and a node removed in one place).
   * 2. Set text an edit the record places deleted later in the commit stays
   *    in the text that arrived, where it is: the old characters aligned
   *    with it are deleted (see compose, where a set replaces it again).
   * 3. A set replaces what the record placed in the node before it: typed
   *    text it replaced left (it stays in the text that left, where it was,
   *    and is new: no old character is aligned with it), and nothing is
   *    pinned there any more.
   * 4. Set text aligns with a removed node's text whole or not at all
   *    (where a removed node in front of a node set whole shares nothing
   *    with the new text, the set node's own text is still kept).
   * 5. Text of nodes made aligns with the text that left as y-prosemirror
   *    aligns a text run: as one text each, node boundaries and formats
   *    left out, by their common start and end (see keptEnds), so that a
   *    line made again from its JSON with one word changed writes that word
   *    alone, whichever nodes held its text. An old character it keeps keeps
   *    its Yjs item, which stays deleted where a peer deleted it (an item is
   *    never put back, and the old text is the one the editor showed, see
   *    Unread); only the changed words are written.
   * Priority: the diff runs over all that arrived, in line order, and text
   * that goes on a node's text (a set) keeps what it is aligned with; set
   * text still new is then aligned with what is left between what is kept,
   * and the text of nodes made last, between what is kept, with all of the
   * text that left there, anchored at the caret wherever it is in it (a
   * highlighter that makes a line's tokens again puts it back where the
   * user typed). False where a text in it is not known.
   */
  private stretch(
    st: Stretch,
    add: (node: NodeKey, s: Segment) => void,
  ): boolean {
    if (st.unknown === true) {
      return false;
    }
    st.left.sort((x, y) => x.at - y.at);
    // Text that arrived, also where an edit the record places deleted it
    // (what it stood for is deleted).
    const arrived = (x: Item) => x.run.kind === LOOSE;
    const ids: (Segment[] | null)[] = st.live.map(() => null);
    const d = st.left.map(x => textOf(x.run)).join('');
    if (d !== '') {
      const all: Span[] = [];
      const sets: Span[] = [];
      const made: Span[] = [];
      let s = '';
      let cursor = -1;
      // Where the caret is in any of it (the text of nodes made, see below).
      let caretAt = -1;
      for (const x of st.live) {
        if (arrived(x)) {
          const n = length(x.run);
          // (The caret says where an edit was made in text that was there
          // before: in a node made in this commit, whatever made it put it.)
          const caret = this.caret;
          if (
            caret !== null &&
            caret.key === x.node &&
            caret.offset >= x.at &&
            caret.offset <= x.at + n
          ) {
            caretAt = s.length + caret.offset - x.at;
            if (this.prevMap.has(caret.key)) {
              cursor = caretAt;
            }
          }
          if (n > 0) {
            const span = {a: s.length, n, x};
            all.push(span);
            (x.run.set === true ? sets : made).push(span);
          }
          s += textOf(x.run);
        }
      }
      if (s !== '') {
        // For set text, a removed node's text is aligned whole or not at
        // all: where the common start of the two texts meets one it does not
        // cover whole, the common start stops there; where the common end
        // meets one it does not cover whole, that text is deleted and the
        // common end goes on past it; and text the common start stopped at
        // that the common end does not cover either is deleted. The text
        // left is `w`; each of its runs starts at `at[k][0]` there and
        // `at[k][1]` in `d`.
        const left = st.left;
        const drop = new Uint8Array(left.length);
        const removed = left.some(x => x.from !== null);
        const group = (k: number, back: boolean): [number, string] => {
          let g = k;
          let t = '';
          const from = left[back ? k - 1 : k].from;
          do {
            const r = left[back ? g - 1 : g].run;
            t = back ? textOf(r) + t : t + textOf(r);
            g += back ? -1 : 1;
          } while (
            from !== null &&
            (back ? g > 0 : g < left.length) &&
            left[back ? g - 1 : g].from === from
          );
          return [g, t];
        };
        // The length of the common start of `t` and `s` from `j` on (end,
        // with `back`, before `j`), not past `lim`.
        const same = (t: string, j: number, lim: number, back: boolean) => {
          const n = Math.min(t.length, back ? j - lim : lim - j);
          const CHUNK = 256;
          let m = 0;
          if (back) {
            while (
              m + CHUNK <= n &&
              t.substring(t.length - m - CHUNK, t.length - m) ===
                s.substring(j - m - CHUNK, j - m)
            ) {
              m += CHUNK;
            }
            while (
              m < n &&
              t.charCodeAt(t.length - 1 - m) === s.charCodeAt(j - 1 - m)
            ) {
              m++;
            }
          } else {
            while (
              m + CHUNK <= n &&
              t.substring(m, m + CHUNK) === s.substring(j + m, j + m + CHUNK)
            ) {
              m += CHUNK;
            }
            while (m < n && t.charCodeAt(m) === s.charCodeAt(j + m)) {
              m++;
            }
          }
          return m;
        };
        let pk = removed ? 0 : left.length;
        let pj = 0;
        // A removed node's text the common start meets and does not cover
        // whole stops it there: the common end may still cover it, and it
        // is deleted only where that does not either. Why: text that
        // arrived before it (a line break made in front of a split tail that
        // the transform made again in nodes of other types) left the tail's
        // text, equal to what arrived after the break, all deleted and
        // written again.
        let blocked = -1;
        while (pk < left.length && pj < s.length) {
          const [g, t] = group(pk, false);
          if (left[pk].from === null) {
            const m = same(t, pj, s.length, false);
            pj += m;
            if (m < t.length) {
              break;
            }
          } else if (s.startsWith(t, pj)) {
            pj += t.length;
          } else {
            blocked = g;
            break;
          }
          pk = g;
        }
        let back = left.length;
        for (let j = s.length; back > pk && j > pj; ) {
          const [g, t] = group(back, true);
          if (left[back - 1].from === null) {
            const m = same(t, j, pj, true);
            j -= m;
            if (m < t.length) {
              break;
            }
          } else if (
            j - t.length >= pj &&
            s.startsWith(t, j - t.length) &&
            // The text the common start stopped at is taken only where it
            // is there once: equal text twice could be either.
            (g !== pk || blocked < 0 || s.indexOf(t, pj) === j - t.length)
          ) {
            j -= t.length;
          } else {
            drop.fill(1, g, back);
          }
          back = g;
        }
        if (blocked >= 0 && back >= blocked) {
          drop.fill(1, pk, blocked);
        }
        // The text that left as it was, also with the text that arrived and
        // left again in place (`passed`, see Stretch): read without it, the
        // characters on its two sides are next to each other, and the diff
        // that takes the common end first can align the end of the old text
        // with an equal character at the end of what arrived (a paste over
        // part of a highlighted line, whose nodes the highlighter made again
        // with the pasted text: `t55z` before the paste, `t87z` at its end).
        const passed = st.passed;
        let was = '';
        const wasAt: number[] = [];
        for (let k = 0, g = 0; k <= left.length; k++) {
          while (
            g < passed.length &&
            (k === left.length ||
              passed[g].at < left[k].at ||
              // (Text with no old position, typed in this commit, is at the
              // old position before it: the line's order says which came
              // first.)
              (passed[g].at - 0.5 === left[k].at &&
                passed[g].ord < left[k].ord))
          ) {
            was += passed[g++].text;
          }
          if (k < left.length) {
            wasAt.push(was.length);
            was += textOf(left[k].run);
          }
        }
        let w = '';
        const at: [number, number, number][] = [];
        const sureAt: [number, number, number][] = [];
        for (let k = 0, pos = 0; k < left.length; k++) {
          const n = length(left[k].run);
          if (drop[k] === 0) {
            at.push([w.length, pos, n]);
            sureAt.push([w.length, wasAt[k], n]);
            w += textOf(left[k].run);
          }
          pos += n;
        }
        // The priority (see above).
        const aligned = this.align(
          sets,
          w,
          s,
          this.align(all, w, s, [], cursor, x => x.x.run.set === true),
          cursor,
        );
        // Blocks over a text made of runs of `d` (`runs`: run `k` starts at
        // `runs[k][0]` there and at `runs[k][1]` in `d`), over `d`.
        const toLeft = (
          blocks: readonly Block[],
          runs: readonly [number, number, number][],
        ): Block[] => {
          const out: Block[] = [];
          for (const b of blocks) {
            // The first run that ends after the block starts.
            let first = 0;
            let last = runs.length;
            while (first < last) {
              const mid = (first + last) >> 1;
              if (runs[mid][0] + runs[mid][2] <= b.o) {
                first = mid + 1;
              } else {
                last = mid;
              }
            }
            for (
              let k = first;
              k < runs.length && runs[k][0] < b.o + b.n;
              k++
            ) {
              const [o0, p0, n] = runs[k];
              const lo = Math.max(b.o, o0);
              const hi = Math.min(b.o + b.n, o0 + n);
              out.push({a: b.a + lo - b.o, n: hi - lo, o: p0 + lo - o0});
            }
          }
          return out;
        };
        let kept = toLeft(aligned, at);
        if (made.length > 0) {
          // The text of nodes made, between what set text keeps, with all
          // of the text that left there, as one text each (see the priority
          // above). A removed inline node (an object character) is left out
          // of it: the one made in its place is new, so the text on its two
          // sides is compared as if it were not there.
          let t = '';
          const runs: [number, number, number][] = [];
          // Where each character of `d` is in `t`.
          const inT = new Int32Array(d.length + 1);
          for (let k = 0, pos = 0; k < left.length; k++) {
            const text = textOf(left[k].run);
            if (left[k].run.atom !== true) {
              runs.push([t.length, pos, text.length]);
              for (let i = 0; i < text.length; i++) {
                inT[pos + i] = t.length + i;
              }
              t += text;
            } else {
              inT[pos] = t.length;
            }
            pos += text.length;
          }
          inT[d.length] = t.length;
          const before = kept.map(b => ({...b, o: inT[b.o]}));
          const filled = this.align(
            made,
            t,
            s,
            before,
            caretAt,
            undefined,
            [],
            true,
          );
          const next: Block[] = [];
          for (let i = 0, j = 0; i < filled.length; i++) {
            if (j < before.length && filled[i] === before[j]) {
              next.push(kept[j++]);
            } else {
              next.push(...toLeft([filled[i]], runs));
            }
          }
          // Between what that keeps, what the made text's alignment of
          // main keeps (each removed node's text whole or not at all,
          // keeping only what the diff that takes the common end first
          // keeps too), so that nothing main keeps is written again unless
          // the text made keeps that old character's place for another one.
          kept = within(
            next,
            toLeft(
              this.align(made, w, s, aligned, cursor, undefined, [
                {at, text: d},
                {at: sureAt, text: was},
              ]),
              at,
            ),
          );
        }
        if (__DEV__) {
          let a = 0;
          let o = 0;
          for (const k of kept) {
            invariant(
              k.n > 0 &&
                k.a >= a &&
                k.o >= o &&
                d.slice(k.o, k.o + k.n) === s.slice(k.a, k.a + k.n),
              '@lexical/y: a stretch keeps an old character out of order or for another character',
            );
            a = k.a + k.n;
            o = k.o + k.n;
          }
        }
        this.place(
          st,
          arrived,
          st.left.map(x => x.run),
          kept,
          ids,
        );
      }
    }

    st.live.forEach((x, k) => {
      if (x.node === null) {
        return;
      }
      const segs = ids[k];
      if (segs !== null) {
        for (const seg of segs) {
          add(x.node, seg);
        }
      } else {
        // Typed (new where it is), or arrived and not placed (new).
        add(x.node, segmentOf(arrived(x) ? {...x.run, kind: NEW} : x.run));
      }
    });
    return true;
  }

  /**
   * Blocks `blocks` (in order, see Block), with the text of spans `spans`
   * (items of what arrived, `s`, in order) that lies between two of them (or
   * one and an end of the stretch) aligned with the text that left between
   * them (of `d`), as one text, by the diff (see stretch): anchored at the
   * caret (`cursor`, in `s`) where it is in that text. With `sure`, only what
   * the diff that takes the common end first keeps too: where the text could
   * be either of two equal runs, neither. That diff reads `d`, and also each
   * reading of the text that left as it was in `sure` (its `text`, of which
   * `d` holds the runs its `at` says, see stretch): with the text deleted
   * whole still in place, and with the text that arrived and left again in
   * this commit in place too; what any reading keeps as the diff does is
   * kept. Why: read
   * without that text, the characters on its two sides are next to each
   * other, which makes the diff's alignment one of two where the line had
   * one (a line made again as one node with one word changed, where that
   * word was a node of its own, wrote the end of the word before it again,
   * and a peer's concurrent edit of the changed word landed inside that
   * word). With `made`, by the common start and end text made again keeps
   * (see keptEnds), and without `sure`.
   */
  private align(
    spans: readonly Span[],
    d: string,
    s: string,
    blocks: readonly Block[],
    cursor: number,
    keeps: (x: Span) => boolean = () => true,
    sure: readonly {
      readonly at: readonly (readonly [number, number, number])[];
      readonly text: string;
    }[] = [],
    made = false,
  ): Block[] {
    type Reading = (typeof sure)[number];
    // The run of `d` (see `sure`) that character `at` of it is in.
    const runOf = (
      r: Reading,
      at: number,
    ): readonly [number, number, number] => {
      const runs = r.at;
      let lo = 0;
      let hi = runs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (runs[mid][0] <= at) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      return runs[lo];
    };
    // Where character `at` of `d` was in the text that left, in reading `r`.
    const old = (r: Reading, at: number): number => {
      const run = runOf(r, at);
      return run[1] + at - run[0];
    };
    const out: Block[] = [];
    let k = 0;
    for (let i = 0; i <= blocks.length; i++) {
      const prev = i > 0 ? blocks[i - 1] : null;
      const next = i < blocks.length ? blocks[i] : null;
      if (prev !== null) {
        out.push(prev);
      }
      const a0 = prev === null ? 0 : prev.a + prev.n;
      const o0 = prev === null ? 0 : prev.o + prev.n;
      const a1 = next === null ? s.length : next.a;
      const o1 = next === null ? d.length : next.o;
      if (a1 <= a0 || o1 <= o0) {
        continue;
      }
      const parts: number[] = [];
      let text = '';
      let caret = -1;
      while (k < spans.length && spans[k].a + spans[k].n <= a0) {
        k++;
      }
      for (let j = k; j < spans.length && spans[j].a < a1; j++) {
        const p0 = Math.max(spans[j].a, a0);
        const p1 = Math.min(spans[j].a + spans[j].n, a1);
        if (cursor >= p0 && cursor <= p1) {
          caret = text.length + cursor - p0;
        }
        parts.push(p0, p1, j);
        text += s.slice(p0, p1);
      }
      if (text === '') {
        continue;
      }
      const w = d.slice(o0, o1);
      // What it keeps, as ranges of `text` and how far on in `w` each is.
      const tl = text.length;
      const shift = w.length - tl;
      let keep: [number, number, number][];
      if (made) {
        keep = keptStretches(w, text, caret, this.composing);
      } else {
        keep = setTextStretches(w, text, caret, this.composing);
      }
      if (sure.length > 0) {
        // Only what the diff that takes the common end first keeps too (see
        // `sure`): in `w`, and where text that left was deleted whole in
        // this part, also in the text that left as it was, from right after
        // the character before it to the character after it; what either
        // reading keeps as the diff does is kept.
        const endFirst = (was: string): [number, number] => {
          const max = Math.min(was.length, tl);
          let q = 0;
          while (
            q < max &&
            was.charCodeAt(was.length - 1 - q) === text.charCodeAt(tl - 1 - q)
          ) {
            q++;
          }
          let p = 0;
          while (p < max - q && was.charCodeAt(p) === text.charCodeAt(p)) {
            p++;
          }
          const snapped = snapToWords(was, text, p, q, this.composing);
          return [snapped.prefix, snapped.suffix];
        };
        const both: [number, number, number][] = [];
        // Character `i` of `text` is character `i + dy` of `w`.
        const [p, q] = endFirst(w);
        const other: [number, number, number][] = [
          [0, p, 0],
          [tl - q, tl, shift],
        ];
        for (const [x0, x1, dx] of keep) {
          for (const [y0, y1, dy] of other) {
            if (dx === dy && Math.min(x1, y1) > Math.max(x0, y0)) {
              both.push([Math.max(x0, y0), Math.min(x1, y1), dx]);
            }
          }
        }
        for (const r of sure) {
          const from = o0 === 0 ? 0 : old(r, o0 - 1) + 1;
          const to = o1 === d.length ? r.text.length : old(r, o1);
          const was = r.text.slice(from, to);
          if (was === w) {
            continue;
          }
          // Character `i` of `text` is character `i + c` of the text that
          // left; in the diff's reading, the run of `w` it is in says.
          const [op, oq] = endFirst(was);
          const olds: [number, number, number][] = [
            [0, op, from],
            [tl - oq, tl, from + was.length - tl],
          ];
          for (const [x0, x1, dx] of keep) {
            for (let x = x0; x < x1; ) {
              const run = runOf(r, o0 + x + dx);
              const end = Math.min(x1, run[0] + run[2] - o0 - dx);
              const c = o0 + dx + run[1] - run[0];
              for (const [y0, y1, cy] of olds) {
                if (c === cy && Math.min(end, y1) > Math.max(x, y0)) {
                  both.push([Math.max(x, y0), Math.min(end, y1), dx]);
                }
              }
              x = end;
            }
          }
        }
        both.sort((x, y) => x[0] - y[0]);
        keep = [];
        for (const r of both) {
          const last = keep[keep.length - 1];
          if (last !== undefined && last[2] === r[2] && r[0] <= last[1]) {
            last[1] = Math.max(last[1], r[1]);
          } else {
            keep.push(r);
          }
        }
      }
      // `keep` is in order of where its ranges start: a cursor past the
      // ranges that end before each part keeps this linear.
      for (let j = 0, t = 0, kp = 0; j < parts.length; j += 3) {
        const p0 = parts[j];
        const n = parts[j + 1] - p0;
        while (kp < keep.length && keep[kp][1] <= t) {
          kp++;
        }
        if (keeps(spans[parts[j + 2]])) {
          for (let q = kp; q < keep.length && keep[q][0] < t + n; q++) {
            const [x0, x1, dx] = keep[q];
            const lo = Math.max(t, x0);
            const hi = Math.min(t + n, x1);
            if (hi > lo) {
              out.push({a: p0 + lo - t, n: hi - lo, o: o0 + lo + dx});
            }
          }
        }
        t += n;
      }
    }
    return out;
  }

  /**
   * Give the arrived items of stretch `st` (`isArrived`, in order) the
   * identities of runs `left` of the text that left it (in order), as
   * blocks `blocks` say (see Block); the rest that arrived is new, and the
   * rest that left is deleted. Into `ids`, by item.
   */
  private place(
    st: Stretch,
    isArrived: (x: Item) => boolean,
    left: readonly Run[],
    blocks: readonly Block[],
    ids: (Segment[] | null)[],
  ): void {
    // A cursor into `left`, moving forward only.
    let li = 0;
    let lpos = 0;
    const take = (p: number, q: number, out: Segment[]) => {
      while (li < left.length && lpos + length(left[li]) <= p) {
        lpos += length(left[li]);
        li++;
      }
      for (let i = li, pos = lpos; i < left.length && pos < q; i++) {
        const r = left[i];
        const n = length(r);
        const s = Math.max(p, pos);
        const e = Math.min(q, pos + n);
        if (e > s) {
          push(
            out,
            segmentOf({...r, end: r.start + e - pos, start: r.start + s - pos}),
          );
        }
        pos += n;
      }
    };
    let pos = 0;
    let b = 0;
    st.live.forEach((x, k) => {
      if (!isArrived(x)) {
        return;
      }
      const out: Segment[] = [];
      const text = textOf(x.run);
      const end = pos + text.length;
      let at = pos;
      const fresh = (to: number) => {
        if (to > at) {
          const t = text.slice(at - pos, to - pos);
          push(out, {end: t.length, key: null, start: 0, text: t});
        }
      };
      while (b < blocks.length && blocks[b].a + blocks[b].n <= pos) {
        b++;
      }
      for (let i = b; i < blocks.length && blocks[i].a < end; i++) {
        const {a, n, o} = blocks[i];
        const s0 = Math.max(a, pos);
        const s1 = Math.min(a + n, end);
        fresh(s0);
        take(o + s0 - a, o + s1 - a, out);
        at = s1;
      }
      fresh(end);
      ids[k] = out;
      pos = end;
    });
  }

  /**
   * The parts of run `r`, which left its place, that no node of the new
   * state holds: a node removed and put back elsewhere, or split and merged
   * into another, holds them there.
   */
  private notLive(r: Run): Run[] {
    if (this.live === null) {
      const live = new Map<string, [number, number][]>();
      const add = (src: string, a: number, b: number) => {
        const list = live.get(src);
        if (list === undefined) {
          live.set(src, [[a, b]]);
        } else {
          list.push([a, b]);
        }
      };
      for (const [key, runs] of this.texts) {
        const node = $getNodeByKey(key);
        if (node === null || !node.isAttached()) {
          continue;
        }
        if (runs === null) {
          // Not known which of its old characters it holds: all of them.
          add(key, 0, Infinity);
        } else {
          for (const x of runs) {
            if (isLive(x)) {
              add(x.src, x.start, x.end);
            }
          }
        }
      }
      for (const list of live.values()) {
        list.sort((x, y) => x[0] - y[0]);
      }
      this.live = live;
    }
    if (r.kind === OLD && !this.texts.has(r.src)) {
      // An old line break or inline node: live where it is attached.
      const node = $getNodeByKey(r.src);
      if (node !== null && !$isTextNode(node) && node.isAttached()) {
        return [];
      }
    }
    const list = this.live.get(r.src);
    if (list === undefined) {
      return [r];
    }
    // The first interval that may overlap (they do not overlap each other).
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid][1] <= r.start) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    const out: Run[] = [];
    let at = r.start;
    for (let i = lo; i < list.length && list[i][0] < r.end; i++) {
      if (list[i][0] > at) {
        out.push({...r, end: list[i][0], start: at});
      }
      at = Math.max(at, list[i][1]);
    }
    if (at < r.end) {
      out.push({...r, start: at});
    }
    return out;
  }
}
