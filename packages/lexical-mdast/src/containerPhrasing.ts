/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Adapted from `lib/util/container-phrasing.js` and the helpers it uses in
// mdast-util-to-markdown 2.2.1 (https://github.com/syntax-tree/mdast-util-to-markdown),
// Copyright (c) Titus Wormer <tituswormer@gmail.com>, MIT license.
//
// mdast-util-to-markdown fixes attention whose markers would not pair one
// mistake at a time, and each try renders and pairs the whole container
// again, so many touching runs serialize in quadratic time. This version
// gives the same output, but a try renders again only the top-level items
// around the attention it changes and pairs only until the first mistake is
// known. It is proposed upstream in
// https://github.com/syntax-tree/mdast-util-to-markdown/issues/96, and can
// go once a release there has it.

import type {Parents, PhrasingContent} from 'mdast';
import type {
  Attention,
  Handle,
  Info,
  State,
  Tracker,
} from 'mdast-util-to-markdown';

import invariant from '@lexical/internal/invariant';
import {
  asciiAlpha,
  asciiAlphanumeric,
  asciiPunctuation,
} from 'micromark-util-character';
import {classifyCharacter} from 'micromark-util-classify-character';
import {htmlBlockNames, htmlRawNames} from 'micromark-util-html-tag-name';

type AttentionHandle = Handle & {attention?: Attention};

/** Attention, whose sequence is chosen later. */
interface AttentionResult {
  /** Serialized children. */
  children: Item[];
  /** Sequences that can be used, in order of preference. */
  sequences: string[];
}

/** Serialized phrasing. */
type Item = AttentionResult | string;

/** Rendered phrasing. */
interface Token {
  /** The attention, if this is one of its sequences. */
  attention: AttentionResult | undefined;
  value: string;
}

/** State of rendering between items. */
interface RenderContext {
  tokens: Token[];
  /** A character to encode if the next item starts with it. */
  encodeAfter: string | undefined;
  /** The last character so far. */
  previous: string;
}

type Choose = (attention: AttentionResult) => string;

/** Sequences next to each other with the same marker, by token index. */
interface ScanRun {
  close: boolean;
  /** Index after the last marker not used (to open). */
  end: number;
  /** The token index of each marker. */
  markers: number[];
  open: boolean;
  /** Whether it can be split (built-in attention). */
  split: boolean;
  /** Index of the first marker not used (to close). */
  start: number;
  /** Token indices of the sequences. */
  tokens: number[];
}

/** The result of pairing a range of tokens. */
interface Scan {
  /** Indices of runs before which nothing is open. */
  empty: number[];
  /** Index of the first sequence that does not form its attention, or -1. */
  first: number;
  /** Sequences involved with that sequence. */
  involved: number[];
  /** Index where scanning stopped. */
  stop: number;
}

// Markers of built-in attention (emphasis, strong) to whether they are
// stricter: whether they cannot open and close inside words. Built-in runs
// pair following the CommonMark rules for emphasis and strong: they are
// split, using one or two markers at a time, with the rule of 3. Other
// markers pair like GFM strikethrough: whole runs pair with a run of the
// same size.
const BUILTINS = new Map([
  ['*', false],
  ['_', true],
]);

/** Serializes the children of a parent that contains phrasing children. */
export function containerPhrasing(
  parent: Parents,
  state: State,
  info: Info,
): string {
  return serialize(phrasing(parent, state, info), info.before, info.after);
}

function firstCharacter(value: string): string {
  const code = value.codePointAt(0);
  return code === undefined ? '' : String.fromCodePoint(code);
}

function lastCharacter(value: string): string {
  // Only a surrogate pair gives a code point above the BMP.
  const code = value.codePointAt(value.length - 2);
  return code !== undefined && code > 0xffff
    ? value.slice(-2)
    : value.slice(-1);
}

/**
 * Which characters around a marker are encoded so that its attention forms.
 * Punctuation is never encoded: markdown constructs, and encoding itself,
 * use it.
 */
function encodeInfo(
  outside: number,
  inside: number,
  marker: string,
): {inside: boolean; outside: boolean} {
  const outsideKind = classifyCharacter(outside);
  const insideKind = classifyCharacter(inside);
  // A letter outside: with a letter inside, both are encoded for `_`, which
  // is looser, and it already forms for others. Whitespace inside, encode
  // both; punctuation inside, the letter outside.
  if (outsideKind === undefined) {
    return insideKind === undefined
      ? marker === '_'
        ? {inside: true, outside: true}
        : {inside: false, outside: false}
      : insideKind === 1
        ? {inside: true, outside: true}
        : {inside: false, outside: true};
  }
  // Whitespace outside: whitespace inside encodes both, else it forms.
  if (outsideKind === 1) {
    return insideKind === 1
      ? {inside: true, outside: true}
      : {inside: false, outside: false};
  }
  // Punctuation outside: whitespace inside is encoded, else it forms.
  return insideKind === 1
    ? {inside: true, outside: false}
    : {inside: false, outside: false};
}

/** The kind of HTML (flow) that `value` would start, if any. */
function htmlKind(value: string): number | undefined {
  if (value.charCodeAt(0) !== 60 /* `<` */) {
    return undefined;
  }
  const next = value.charCodeAt(1);
  if (next === 33 /* `!` */) {
    const code = value.charCodeAt(2);
    return code === 45 /* `-` */
      ? 2
      : code === 91 /* `[` */
        ? 5
        : asciiAlpha(code)
          ? 4
          : undefined;
  }
  if (next === 63 /* `?` */) {
    return 3;
  }
  const closing = next === 47; /* `/` */
  const start = closing ? 2 : 1;
  let end = start;
  let code = value.charCodeAt(end);
  if (!asciiAlpha(code)) {
    return undefined;
  }
  while (code === 45 /* `-` */ || asciiAlphanumeric(code)) {
    code = value.charCodeAt(++end);
  }
  const name = value.slice(start, end).toLowerCase();
  if (!closing && code !== 47 /* `/` */ && htmlRawNames.includes(name)) {
    return 1;
  }
  return htmlBlockNames.includes(name) ? 6 : 7;
}

/**
 * Encodes the first or last character of `tokens` as a character reference,
 * if it is text.
 */
function encode(tokens: Token[], start: boolean): void {
  const token = tokens[start ? 0 : tokens.length - 1];
  if (!token || token.attention) {
    return;
  }
  const character = start
    ? firstCharacter(token.value)
    : lastCharacter(token.value);
  const reference =
    '&#x' +
    (character.codePointAt(0) as number).toString(16).toUpperCase() +
    ';';
  if (start) {
    token.value = reference + token.value.slice(character.length);
  } else {
    let value = token.value.slice(0, token.value.length - character.length);
    let escapes = 0;
    while (value.charCodeAt(value.length - 1 - escapes) === 92 /* `\` */) {
      escapes++;
    }
    // An odd number would escape the `&` again.
    if (escapes % 2) {
      value += '\\';
    }
    token.value = value + reference;
  }
}

/** The sequences that can be used for attention, in order of preference. */
function attentionSequences(
  type: string,
  markers: readonly string[],
  sizes: readonly number[],
): string[] {
  invariant(
    markers.length > 0,
    'Cannot serialize %s as attention without markers',
    type,
  );
  invariant(
    sizes.length > 0,
    'Cannot serialize %s as attention without sizes',
    type,
  );
  for (const size of sizes) {
    invariant(
      Number.isSafeInteger(size) && size >= 1,
      'Cannot serialize %s as attention with %s as size',
      type,
      String(size),
    );
  }
  const sequences: string[] = [];
  for (const marker of markers) {
    invariant(
      marker.length === 1 && asciiPunctuation(marker.charCodeAt(0)),
      'Cannot serialize %s as attention with %s as marker',
      type,
      marker,
    );
    for (const size of sizes) {
      sequences.push(marker.repeat(size));
    }
  }
  return sequences;
}

/**
 * Serializes the children of a parent that contains phrasing children,
 * keeping attention separate so that its markers can be chosen later.
 */
function phrasing(parent: Parents, state: State, info: Info): Item[] {
  const {indexStack} = state;
  const children = (parent.children || []) as PhrasingContent[];
  // The handlers are a `zwitch`.
  const handlers = (
    state.handle as unknown as {
      handlers: Record<string, AttentionHandle & {peek?: Handle}>;
    }
  ).handlers;
  const results: Item[] = [];
  let before = info.before;
  indexStack.push(-1);
  let tracker = state.createTracker(info);
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    indexStack[indexStack.length - 1] = index;
    let after: string;
    if (index + 1 < children.length) {
      const next = handlers[children[index + 1].type];
      const handle = next && (next.peek || next);
      after = handle
        ? firstCharacter(
            handle(children[index + 1], parent, state, {
              after: '',
              before: '',
              ...tracker.current(),
            }),
          )
        : '';
    } else {
      after = info.after;
    }
    // HTML (text) right after an end of line could be read as HTML (flow),
    // which all its kinds but 7 can interrupt a paragraph as. It cannot be
    // escaped, so the end of line becomes a space.
    const previous = results[results.length - 1];
    if (
      typeof previous === 'string' &&
      (before === '\r' || before === '\n') &&
      child.type === 'html' &&
      htmlKind(child.value) !== 7
    ) {
      results[results.length - 1] = previous.replace(/(\r?\n|\r)$/, ' ');
      before = ' ';
      tracker = state.createTracker(info);
      tracker.move(serialize(results, info.before, info.after));
    }
    const handle = handlers[child.type];
    if (handle && handle.attention) {
      const item = attentionItem(
        child as Parents,
        handle.attention,
        state,
        tracker,
      );
      results.push(item);
      before = lastCharacter(item.sequences[0]);
    } else {
      const value = state.handle(child, parent, state, {
        ...tracker.current(),
        after,
        before,
      });
      if (!value) {
        continue;
      }
      tracker.move(value);
      results.push(value);
      before = lastCharacter(value);
    }
  }
  indexStack.pop();
  return results;
}

/** Serializes a node as attention, with its sequence chosen later. */
function attentionItem(
  node: Parents,
  attention: Attention,
  state: State,
  tracker: Tracker,
): AttentionResult {
  const {construct, markers, sizes} = attention(node as never, state);
  const sequences = attentionSequences(node.type, markers, sizes);
  const sequence = sequences[0];
  const exit = state.enter(construct);
  tracker.move(sequence);
  const children = phrasing(node, state, {
    ...tracker.current(),
    after: sequence,
    before: sequence,
  });
  tracker.move(serialize(children, sequence, sequence));
  tracker.move(sequence);
  exit();
  return {children, sequences};
}

/**
 * Pairs runs of sequences like micromark, from a token where nothing is
 * open, until it is known which sequence is the first that does not form
 * its attention.
 *
 * Sequences of `*` and `_` pair like emphasis and strong in CommonMark,
 * others like strikethrough in GFM. Each pair uses markers from the end of
 * an opener and the start of a closer. It forms the intended attention if
 * those markers are exactly the whole opening and closing sequence of one
 * attention. Otherwise the sequences involved are recorded with each other.
 */
function scan(
  tokenAt: (index: number) => Token,
  length: number,
  from: number,
  before: string,
  after: string,
): Scan {
  const openersByMarker = new Map<string, ScanRun[]>();
  const wrong = new Map<number, number[]>();
  const empty: number[] = [];
  const pending: ScanRun[] = [];
  let first = -1;
  let index = from;

  // Notes that the sequences of a run are done pairing.
  const done = (run: ScanRun) => {
    for (const at of run.tokens) {
      if (wrong.has(at) && (first === -1 || at < first)) {
        first = at;
      }
    }
  };
  // Whether the first mistake is known.
  const known = () => {
    if (first === -1) {
      return false;
    }
    for (const run of pending) {
      for (const at of run.tokens) {
        if (at < first && wrong.has(at)) {
          return false;
        }
      }
    }
    return true;
  };

  while (index < length) {
    const token = tokenAt(index);
    if (!token.attention) {
      index++;
      continue;
    }
    if (pending.length === 0) {
      empty.push(index);
    }
    const marker = token.value.charAt(0);
    const strict = BUILTINS.get(marker);
    let end = index + 1;
    while (end < length && isMarker(tokenAt(end), marker)) {
      end++;
    }
    const head = index ? tokenAt(index - 1).value : before;
    const previous = classifyCharacter(head.charCodeAt(head.length - 1));
    const next = classifyCharacter(
      (end < length ? tokenAt(end).value : after).charCodeAt(0),
    );
    const canOpen = !next || (next === 2 && Boolean(previous));
    const canClose = !previous || (previous === 2 && Boolean(next));
    const tokens: number[] = [];
    const closer: ScanRun = {
      // Underscores are strict, they cannot open or close inside words.
      close: strict ? canClose && (Boolean(next) || !canOpen) : canClose,
      end: 0,
      markers: [],
      open: strict ? canOpen && (Boolean(previous) || !canClose) : canOpen,
      // All built-ins can split runs.
      split: strict !== undefined,
      start: 0,
      tokens,
    };
    for (let at = index; at < end; at++) {
      tokens.push(at);
    }
    for (const at of tokens) {
      // Every sequence is wrong until it pairs with its other sequence.
      wrong.set(at, [...tokens]);
      for (let size = tokenAt(at).value.length; size > 0; size--) {
        closer.markers.push(at);
      }
    }
    closer.end = closer.markers.length;
    let openers = openersByMarker.get(marker);
    if (!openers) {
      openers = [];
      openersByMarker.set(marker, openers);
    }
    let at = closer.close ? openers.length : 0;
    while (at-- && closer.start < closer.end) {
      const opener = openers[at];
      const openerSize = opener.end - opener.start;
      const closerSize = closer.end - closer.start;
      if (
        closer.split
          ? // The rule of 3, on the sizes that are left.
            (opener.close || closer.open) &&
            closerSize % 3 &&
            !((openerSize + closerSize) % 3)
          : // Others pair whole runs of the same size.
            openerSize !== opener.markers.length || openerSize !== closerSize
      ) {
        continue;
      }
      const size = closer.split
        ? openerSize > 1 && closerSize > 1
          ? 2
          : 1
        : closerSize;
      const opening = opener.markers.slice(opener.end - size, opener.end);
      const closing = closer.markers.slice(closer.start, closer.start + size);
      const openIndex = opening[0];
      const closeIndex = closing[0];
      if (
        // Whole sequences: the markers of a sequence are next to each other,
        // so if the first and last marker are of one sequence of that size,
        // all the markers are exactly that sequence.
        openIndex === opening[size - 1] &&
        tokenAt(openIndex).value.length === size &&
        closeIndex === closing[size - 1] &&
        tokenAt(closeIndex).value.length === size &&
        // Of the same attention, so its opening and closing sequence.
        tokenAt(openIndex).attention === tokenAt(closeIndex).attention
      ) {
        wrong.delete(openIndex);
        wrong.delete(closeIndex);
      } else {
        const involved = [...new Set([...opening, ...closing])];
        // Add to what is involved already: a sequence can be in several
        // pairs.
        for (const one of involved) {
          const list = wrong.get(one);
          if (list) {
            list.push(...involved);
          }
        }
      }
      opener.end -= size;
      closer.start += size;
      if (opener.start === opener.end) {
        openers.splice(at, 1);
        pending.splice(pending.indexOf(opener), 1);
        done(opener);
      }
      // Search again from the start, as this run may close more.
      at = openers.length;
    }
    if (closer.open && closer.start < closer.end) {
      openers.push(closer);
      pending.push(closer);
    } else {
      done(closer);
    }
    index = end;
    if (known()) {
      break;
    }
  }
  // At the end, what is still open does not form.
  if (index >= length) {
    for (const run of pending) {
      done(run);
    }
  }
  return {
    empty,
    first,
    involved: first === -1 ? [] : (wrong.get(first) as number[]),
    stop: index,
  };
}

/**
 * Renders the item at `index`, encoding characters around attention where
 * needed, and updates `context`.
 */
function renderItem(
  items: Item[],
  index: number,
  choose: Choose,
  after: string,
  context: RenderContext,
): void {
  const {tokens} = context;
  const item = items[index];
  if (typeof item === 'string') {
    const token: Token = {attention: undefined, value: item};
    // If attention before had to encode the character after it, encode it.
    if (context.encodeAfter && context.encodeAfter === firstCharacter(item)) {
      encode([token], true);
    }
    context.encodeAfter = undefined;
    tokens.push(token);
    if (token.value) {
      context.previous = lastCharacter(token.value);
    }
    return;
  }
  const sequence = choose(item);
  const marker = sequence.charAt(0);
  const next = items[index + 1];
  const outsideBefore = context.previous;
  const outsideAfter = firstCharacter(
    next === undefined ? after : typeof next === 'string' ? next : choose(next),
  );
  const inside: RenderContext = {
    encodeAfter: undefined,
    previous: lastCharacter(sequence),
    tokens: [],
  };
  for (let at = 0; at < item.children.length; at++) {
    renderItem(item.children, at, choose, sequence, inside);
  }
  const insideTokens = inside.tokens;
  const head = insideTokens.length > 0 ? insideTokens[0].value : '';
  const open = encodeInfo(
    outsideBefore.charCodeAt(outsideBefore.length - 1),
    head.charCodeAt(0),
    marker,
  );
  if (open.inside) {
    encode(insideTokens, true);
  }
  const tail =
    insideTokens.length > 0
      ? lastCharacter(insideTokens[insideTokens.length - 1].value)
      : '';
  const close = encodeInfo(
    outsideAfter.charCodeAt(0),
    tail.charCodeAt(tail.length - 1),
    marker,
  );
  if (close.inside) {
    encode(insideTokens, false);
  }
  if (open.outside && outsideBefore !== '\n' && outsideBefore !== '\r') {
    encode(tokens, false);
  }
  if (close.outside) {
    context.encodeAfter = outsideAfter;
  }
  tokens.push({attention: item, value: sequence}, ...insideTokens, {
    attention: item,
    value: sequence,
  });
  context.previous = sequence.charAt(sequence.length - 1);
}

/**
 * Serializes phrasing with attention.
 *
 * Whether attention forms depends on everything around it. This checks that
 * it does and tries other sequences if not: for the first mistake, it tries
 * other sequences for the attention involved, and uses the first that moves
 * the mistake further.
 *
 * Changing the sequence of attention changes the tokens of the top-level
 * item it is in and those next to it, and how runs pair until the next point
 * where nothing is open. So a try renders and pairs only that part again.
 */
function serialize(items: Item[], before: string, after: string): string {
  const chosen = new Map<AttentionResult, string>();
  const preferred: Choose = attention =>
    chosen.get(attention) || attention.sequences[0];
  const context: RenderContext = {
    encodeAfter: undefined,
    previous: lastCharacter(before),
    tokens: [],
  };
  // For each item: its first token, and the state of rendering before it,
  // including the value of the token before it, before it is encoded.
  const starts: number[] = [];
  const previouses: string[] = [];
  const encodeAfters: (string | undefined)[] = [];
  const lasts: (string | undefined)[] = [];
  const tokens = context.tokens;
  for (let index = 0; index < items.length; index++) {
    starts.push(tokens.length);
    previouses.push(context.previous);
    encodeAfters.push(context.encodeAfter);
    lasts.push(tokens.length > 0 ? tokens[tokens.length - 1].value : undefined);
    renderItem(items, index, preferred, after, context);
  }
  const {length} = tokens;
  starts.push(length);
  const initial = join(tokens);

  // Each attention, deep, to the top-level item it is in.
  const top = new Map<AttentionResult, number>();
  const tops = (attention: AttentionResult, index: number) => {
    top.set(attention, index);
    for (const child of attention.children) {
      if (typeof child !== 'string') {
        tops(child, index);
      }
    }
  };
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (typeof item !== 'string') {
      tops(item, index);
    }
  }
  // Each attention to the indices of its opening and closing sequence.
  const positions = new Map<AttentionResult, [number, number]>();
  for (let index = 0; index < length; index++) {
    const {attention} = tokens[index];
    if (attention) {
      const found = positions.get(attention);
      if (found) {
        found[1] = index;
      } else {
        positions.set(attention, [index, index]);
      }
    }
  }

  // The pairing of the current tokens, as far as `known`: which tokens start
  // a run before which nothing is open.
  const empty = new Uint8Array(length);
  let known = 0;
  const apply = (scanned: Scan, from: number) => {
    empty.fill(0, from, scanned.stop);
    for (const at of scanned.empty) {
      empty[at] = 1;
    }
    known = scanned.stop;
  };

  // Attention to try other sequences for, for a mistake: the attention
  // involved and attention in runs with its sequences, later first, since
  // attention that opens later is inner or next.
  const candidates = (involved: number[]): AttentionResult[] => {
    const attentions = new Set<AttentionResult>();
    for (const at of involved) {
      const {attention} = tokens[at];
      if (attention) {
        attentions.add(attention);
      }
    }
    const related = new Set<AttentionResult>();
    for (const attention of attentions) {
      for (const at of positions.get(attention) as [number, number]) {
        const marker = tokens[at].value.charAt(0);
        let start = at;
        let end = at + 1;
        while (start > 0 && isMarker(tokens[start - 1], marker)) {
          start--;
        }
        while (end < length && isMarker(tokens[end], marker)) {
          end++;
        }
        for (; start < end; start++) {
          related.add(tokens[start].attention as AttentionResult);
        }
      }
    }
    return [...related].sort(
      (a, b) =>
        (positions.get(b) as [number, number])[0] -
        (positions.get(a) as [number, number])[0],
    );
  };

  // Tries `sequence` for `attention`, and uses it if that moves the first
  // mistake past `mistake`.
  const attempt = (
    attention: AttentionResult,
    sequence: string,
    mistake: number,
  ): Scan | undefined => {
    const choose: Choose = other =>
      other === attention ? sequence : preferred(other);
    const changed = top.get(attention) as number;
    const first = Math.max(0, changed - 1);
    const copy = starts[first] > 0;
    const fresh: RenderContext = {
      encodeAfter: encodeAfters[first],
      previous: previouses[first],
      tokens: copy
        ? [
            {
              attention: tokens[starts[first] - 1].attention,
              value: lasts[first] as string,
            },
          ]
        : [],
    };
    const offset = starts[first] - (copy ? 1 : 0);
    const records: [number, string, string | undefined, string][] = [];
    let end = length;
    for (let last = first; last < items.length; ) {
      renderItem(items, last, choose, after, fresh);
      last++;
      if (last === items.length) {
        continue;
      }
      const value = fresh.tokens[fresh.tokens.length - 1].value;
      records.push([last, fresh.previous, fresh.encodeAfter, value]);
      // Where rendering is as before, the rest is too.
      if (
        last > changed + 1 &&
        fresh.previous === previouses[last] &&
        fresh.encodeAfter === encodeAfters[last] &&
        value === lasts[last]
      ) {
        // The token before `last` is encoded by `last` as before.
        fresh.tokens.pop();
        end = starts[last] - 1;
        break;
      }
    }
    const tokenAt = (at: number): Token =>
      at >= offset && at < end ? fresh.tokens[at - offset] : tokens[at];
    // Start pairing where nothing is open, before any change. Pairing stops
    // right after the mistake is known, so that is not after the mistake.
    let from = Math.min(offset, known) - 1;
    while (from > 0 && empty[from] === 0) {
      from--;
    }
    from = Math.max(from, 0);
    const scanned = scan(tokenAt, length, from, before, after);
    if (scanned.first !== -1 && scanned.first <= mistake) {
      return undefined;
    }
    chosen.set(attention, sequence);
    for (let at = offset; at < end; at++) {
      tokens[at] = fresh.tokens[at - offset];
    }
    for (const [item, previous, encodeAfter, value] of records) {
      previouses[item] = previous;
      encodeAfters[item] = encodeAfter;
      lasts[item] = value;
    }
    apply(scanned, from);
    return scanned;
  };

  let result: Scan | undefined = scan(
    at => tokens[at],
    length,
    0,
    before,
    after,
  );
  apply(result, 0);
  while (result.first !== -1) {
    const {first: mistake, involved}: Scan = result;
    result = undefined;
    for (const attention of candidates(involved)) {
      const current = preferred(attention);
      for (const sequence of attention.sequences) {
        if (sequence !== current) {
          result = attempt(attention, sequence, mistake);
          if (result) {
            break;
          }
        }
      }
      if (result) {
        break;
      }
    }
    if (!result) {
      return initial;
    }
  }
  return join(tokens);
}

/** Whether `token` is a sequence of `marker`. */
function isMarker(token: Token, marker: string): boolean {
  return Boolean(token.attention) && token.value.charAt(0) === marker;
}

function join(tokens: Token[]): string {
  let result = '';
  for (const token of tokens) {
    result += token.value;
  }
  return result;
}
