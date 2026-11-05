/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Whether an update inserts no character: it only deletes, moves or
 * re-keys text, so that undoing all of it (a refusal reads the document
 * again) undoes no typed character, and leaves every character of the
 * result once, in its order. Pure: from the text of the text nodes before
 * and after, by key (the text as stored), and the order of the old ones in
 * the document. Characters are counted by code point (a character outside
 * the BMP is one, never made of two others' surrogates).
 *
 * Insertion free where some assignment exists of the removed text nodes,
 * in runs between kept ones in the old document order, each run to one of:
 * - the kept text node before it (its text after that node's old text);
 * - the kept text node after it (its text before that node's old text);
 * - one text node the update made (each made node gets at most one run);
 * - none (deleted);
 * such that every kept text node's new text is what deleting characters
 * from [the run before it, if assigned to it] + its old text + [the run
 * after it, if assigned to it] gives, and every made text node with text
 * is what deleting characters from its run gives. That covers an unwrap
 * whose text Lexical merges into the text next to it, a block cut and
 * pasted (new keys, the same text), a node replaced by one of another key.
 * Typing, a composition's text, paste, a permutation (an autocorrect of
 * `teh` to `the`), and text from nothing are not insertion free. Where the
 * runs are too many to search (more than MAX_RUNS), or nothing fits, the
 * update counts as inserting: never refused for a character it may have
 * typed.
 */
export function insertionFree(
  prev: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
  prevOrder: () => readonly string[],
): {free: boolean; reason: string} {
  const changed: string[] = [];
  const made: string[] = [];
  for (const [key, text] of next) {
    const was = prev.get(key);
    if (was === undefined) {
      if (text !== '') {
        made.push(text);
      }
    } else if (was !== text) {
      changed.push(key);
    }
  }
  if (changed.length === 0 && made.length === 0) {
    return {free: true, reason: 'no text changed or made'};
  }
  const removed = new Map<string, string>();
  for (const [key, text] of prev) {
    if (!next.has(key) && text !== '') {
      removed.set(key, text);
    }
  }
  // Fast: a character more times than before.
  const count = new Map<string, number>();
  const add = (text: string, by: number) => {
    for (const ch of text) {
      count.set(ch, (count.get(ch) || 0) + by);
    }
  };
  for (const key of changed) {
    add(prev.get(key)!, 1);
    add(next.get(key)!, -1);
  }
  for (const text of removed.values()) {
    add(text, 1);
  }
  for (const text of made) {
    add(text, -1);
  }
  for (const [ch, n] of count) {
    if (n < 0) {
      return {free: false, reason: `a character more: ${JSON.stringify(ch)}`};
    }
  }
  type Run = {left: number; right: number; text: string};
  const runs: Run[] = [];
  const kept: string[] = [];
  let run: Run | null = null;
  for (const key of prevOrder()) {
    if (!next.has(key)) {
      if (run === null) {
        run = {left: kept.length - 1, right: -1, text: ''};
        runs.push(run);
      }
      run.text += removed.get(key) || '';
    } else {
      if (run !== null) {
        run.right = kept.length;
        run = null;
      }
      kept.push(key);
    }
  }
  if (runs.length > MAX_RUNS) {
    return {free: false, reason: `${runs.length} runs of removed text`};
  }
  const keptAt = new Map(kept.map((k, i) => [k, i]));
  for (const key of changed) {
    if (!keptAt.has(key)) {
      return {free: false, reason: 'a changed text node out of order'};
    }
  }
  // Per run: NONE, LEFT, RIGHT, or the index of the made node it goes to.
  const choice: number[] = runs.map(() => NONE);
  const used = new Set<number>();
  // Per changed text node: the run right before it and right after it (at
  // most one each), and whether its new text fits each of the four ways
  // they can be given to it (bit 1: the run before, bit 2: the run after),
  // checked once, so a full assignment is checked in time linear in the
  // changed nodes.
  const sides = changed.map(key => {
    const i = keptAt.get(key)!;
    const before = runs.findIndex(r => r.right === i);
    const after = runs.findIndex(r => r.left === i);
    const fit: boolean[] = [];
    for (let b = 0; b < 4; b++) {
      fit.push(
        isSubsequence(
          next.get(key)!,
          (b & 1 && before >= 0 ? runs[before].text : '') +
            prev.get(key)! +
            (b & 2 && after >= 0 ? runs[after].text : ''),
        ),
      );
    }
    return {after, before, fit};
  });
  if (sides.some(({fit}) => !fit.includes(true))) {
    return {free: false, reason: 'a changed text node no run gives'};
  }
  const fits = (): boolean =>
    sides.every(
      ({before, after, fit}) =>
        fit[
          (before >= 0 && choice[before] === RIGHT ? 1 : 0) |
            (after >= 0 && choice[after] === LEFT ? 2 : 0)
        ],
    ) && made.every((_t, m) => choice.includes(m));
  // A made node can take only a run its text is a subsequence of.
  const takes = runs.map(r => made.map(text => isSubsequence(text, r.text)));
  // Every made node needs a run; the search stops after MAX_STEPS
  // assignments tried, counting the update as inserting (never refused for
  // a character it may have typed).
  if (made.some((_t, m) => !takes.some(row => row[m]))) {
    return {free: false, reason: 'a made text node no removed run gives'};
  }
  let steps = 0;
  let exhausted = false;
  const search = (k: number): boolean => {
    if (++steps > MAX_STEPS) {
      exhausted = true;
      return false;
    }
    if (k === runs.length) {
      return fits();
    }
    // Every made node still needs a run of its own.
    if (runs.length - k < made.length - used.size) {
      return false;
    }
    for (const o of [...made.map((_t, m) => m), NONE, LEFT, RIGHT]) {
      if (exhausted) {
        return false;
      }
      if (
        (o === LEFT && runs[k].left < 0) ||
        (o === RIGHT && runs[k].right < 0) ||
        (o >= 0 && (used.has(o) || !takes[k][o]))
      ) {
        continue;
      }
      choice[k] = o;
      if (o >= 0) {
        used.add(o);
      }
      if (search(k + 1)) {
        return true;
      }
      if (o >= 0) {
        used.delete(o);
      }
    }
    choice[k] = NONE;
    return false;
  };
  if (search(0)) {
    return {free: true, reason: 'every character from an old one, in order'};
  }
  return exhausted
    ? {free: false, reason: `more than ${MAX_STEPS} assignments tried`}
    : {free: false, reason: 'no assignment of the removed text fits'};
}

/** The most runs of removed text the search tries (see insertionFree). */
export const MAX_RUNS = 8;

/** The most assignments the search tries (see insertionFree). */
export const MAX_STEPS = 20000;

const NONE = -1;
const LEFT = -2;
const RIGHT = -3;

/** Whether deleting code points from `whole` can give `part`. */
export function isSubsequence(part: string, whole: string): boolean {
  const want = Array.from(part);
  let i = 0;
  for (const ch of whole) {
    if (i < want.length && want[i] === ch) {
      i++;
    }
  }
  return i === want.length;
}
