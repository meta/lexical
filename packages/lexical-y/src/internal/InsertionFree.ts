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
 * - one text node the update made (each made node gets at most one run,
 *   or several next to each other between the same two kept nodes, in
 *   their order: the text one run held before some of its nodes became runs
 *   of their own, below),
 *   or, where that finds none, the text nodes of one subtree the update
 *   made taken together, in their order (`madeGroups`: a node replaced by a
 *   copy of it under new keys, a block of several text nodes cut and
 *   pasted);
 * - none (deleted);
 * - for a removed node of a container the update moved or removed, which
 *   the update's own record says it merged into a kept node (`donors`, a
 *   run of its own): that kept node, before or after its text as recorded;
 * (a kept text node the update moved elsewhere with its text as it was,
 * `moved`, is no neighbour: the text on both sides of where it was is
 * adjacent once it is gone; a run between two
 * kept nodes goes to either only where they are adjacent in the new order,
 * `nextOrder`)
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
  nextOrder: () => readonly string[],
  moved: () => ReadonlySet<string> = () => new Set(),
  donors: () => ReadonlyMap<string, Recipient | null> = () => new Map(),
  madeGroups?: () => readonly (readonly string[])[],
): InsertionVerdict {
  const verdict = insertionFreeAs(
    prev,
    next,
    prevOrder,
    nextOrder,
    moved,
    donors,
    null,
  );
  if (verdict.free || madeGroups === undefined) {
    return verdict;
  }
  // The text nodes of a subtree the update made, as one: one run of removed
  // text can give all of them, in their order (a copy of a node under new
  // keys). Each of the two searches is sound alone.
  const grouped = insertionFreeAs(
    prev,
    next,
    prevOrder,
    nextOrder,
    moved,
    donors,
    madeGroups(),
  );
  return grouped.free ? grouped : verdict;
}

function insertionFreeAs(
  prev: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
  prevOrder: () => readonly string[],
  nextOrder: () => readonly string[],
  moved: () => ReadonlySet<string>,
  donors: () => ReadonlyMap<string, Recipient | null>,
  groups: readonly (readonly string[])[] | null,
): InsertionVerdict {
  const changed: string[] = [];
  const made: string[] = [];
  // Made text nodes taken together, by the subtree that holds them.
  const inGroup = new Set<string>();
  for (const group of groups ?? []) {
    let text = '';
    for (const key of group) {
      const now = next.get(key);
      if (now !== undefined && !prev.has(key)) {
        inGroup.add(key);
        text += now;
      }
    }
    if (text !== '') {
      made.push(text);
    }
  }
  for (const [key, text] of next) {
    const was = prev.get(key);
    if (was === undefined) {
      if (text !== '' && !inGroup.has(key)) {
        made.push(text);
      }
    } else if (was !== text) {
      changed.push(key);
    }
  }
  if (changed.length === 0 && made.length === 0) {
    return {changesText: false, free: true, reason: 'no text changed or made'};
  }
  const verdict = (free: boolean, reason: string): InsertionVerdict => ({
    changesText: true,
    free,
    reason,
  });
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
      return verdict(false, `a character more: ${JSON.stringify(ch)}`);
    }
  }
  type Run = {
    donor: boolean;
    left: number;
    recipient: Recipient | null;
    right: number;
    text: string;
  };
  const runs: Run[] = [];
  const kept: string[] = [];
  let run: Run | null = null;
  // Runs waiting for the kept node after them.
  const pending: Run[] = [];
  const away = moved();
  const givers = donors();
  for (const key of prevOrder()) {
    if (away.has(key) && next.get(key) === prev.get(key)) {
      // Kept as it was, but moved elsewhere: no neighbour of the text around
      // where it was. (One whose text changed takes only the runs next to it
      // on both sides, as one kept in place.)
      continue;
    }
    if (!next.has(key) && givers.has(key)) {
      // A removed node of a container the update moved or removed: a run
      // of its own, which can also have moved and merged elsewhere.
      const own: Run = {
        donor: true,
        left: kept.length - 1,
        recipient: givers.get(key) ?? null,
        right: -1,
        text: removed.get(key) || '',
      };
      run = null;
      runs.push(own);
      pending.push(own);
      continue;
    }
    if (!next.has(key)) {
      if (run === null) {
        run = {
          donor: false,
          left: kept.length - 1,
          recipient: null,
          right: -1,
          text: '',
        };
        runs.push(run);
        pending.push(run);
      }
      run.text += removed.get(key) || '';
    } else {
      for (const r of pending) {
        r.right = kept.length;
      }
      pending.length = 0;
      run = null;
      kept.push(key);
    }
  }
  if (runs.length > MAX_RUNS) {
    return verdict(false, `${runs.length} runs of removed text`);
  }
  // A run between two kept nodes goes to either only where they are next to
  // each other once it is gone (the run lay between them, moved nodes
  // aside, and nothing else came between them).
  // (Kept nodes moved elsewhere unchanged aside, in the new order too.)
  const at = new Map(
    nextOrder()
      .filter(k => !(away.has(k) && next.get(k) === prev.get(k)))
      .map((k, i) => [k, i]),
  );
  const touching = (r: Run) =>
    r.left < 0 ||
    r.right < 0 ||
    at.get(kept[r.right])! - at.get(kept[r.left])! === 1;
  const keptAt = new Map(kept.map((k, i) => [k, i]));
  for (const key of changed) {
    if (!keptAt.has(key) && !away.has(key)) {
      return verdict(false, 'a changed text node out of order');
    }
  }
  // A run of its own (see donors) can also go to the kept node the record
  // says it merged into.
  const far: Recipient[][] = runs.map(r =>
    r.recipient !== null && keptAt.has(r.recipient.key) ? [r.recipient] : [],
  );
  const FAR = -10;
  // Per run: NONE, LEFT, RIGHT, the index of the made node it goes to, or
  // FAR - n for its nth far place.
  const choice: number[] = runs.map(() => NONE);
  const used = new Set<number>();
  // Per changed kept node: the runs that can be given to it (before it,
  // after it, or merged into it), and whether its new text fits each set of
  // them given, checked once per set (memoized), so that a full assignment
  // is checked in time linear in the changed nodes and their runs.
  const sides = changed.flatMap(key => {
    const i = keptAt.get(key);
    if (i === undefined) {
      return [];
    }
    // Whether run k is given to this node, on that side.
    const given = (k: number, before: boolean): boolean => {
      const r = runs[k];
      const o = choice[k];
      const place = o <= FAR ? far[k][FAR - o] : null;
      return before
        ? (o === RIGHT && r.right === i) ||
            (place !== null && place.key === key && place.side === 'before')
        : (o === LEFT && r.left === i) ||
            (place !== null && place.key === key && place.side === 'after');
    };
    const cands: {k: number; before: boolean}[] = [];
    runs.forEach((r, k) => {
      if (
        r.right === i ||
        far[k].some(p => p.key === key && p.side === 'before')
      ) {
        cands.push({before: true, k});
      }
      if (
        r.left === i ||
        far[k].some(p => p.key === key && p.side === 'after')
      ) {
        cands.push({before: false, k});
      }
    });
    const memo = new Map<number, boolean>();
    const fit = (): boolean => {
      let mask = 0;
      cands.forEach(({k, before}, n) => {
        if (given(k, before)) {
          mask |= 1 << n;
        }
      });
      let known = memo.get(mask);
      if (known === undefined) {
        // In the order the record merged them where it tells (rank), else
        // in document order.
        const rankOf = (k: number, b: boolean): number | undefined => {
          const place = far[k].find(
            p => p.key === key && p.side === (b ? 'before' : 'after'),
          );
          return place === undefined ? undefined : place.rank;
        };
        const parts: {b: boolean; k: number; rank: number | undefined}[] = [];
        cands.forEach(({k, before: b}, n) => {
          if (mask & (1 << n)) {
            parts.push({b, k, rank: rankOf(k, b)});
          }
        });
        parts.sort((x, y) =>
          x.rank !== undefined && y.rank !== undefined
            ? x.rank - y.rank
            : x.rank !== undefined
              ? -1
              : y.rank !== undefined
                ? 1
                : x.k - y.k,
        );
        let before = '';
        let after = '';
        for (const {b, k} of parts) {
          if (b) {
            before += runs[k].text;
          } else {
            after += runs[k].text;
          }
        }
        known = isSubsequence(next.get(key)!, before + prev.get(key)! + after);
        memo.set(mask, known);
      }
      return known;
    };
    return [fit];
  });
  // Runs next to each other between the same two kept nodes: the text one
  // run held before its nodes became runs of their own (donors). A made node
  // can take several of them, in their order (a copy of a node whose text
  // Lexical merged into one text node), each given once.
  const sameBlock = (k: number) =>
    k > 0 &&
    runs[k - 1].left === runs[k].left &&
    runs[k - 1].right === runs[k].right;
  const blockText: string[] = [];
  for (let k = runs.length - 1; k >= 0; k--) {
    blockText[k] =
      runs[k].text +
      (k + 1 < runs.length && sameBlock(k + 1) ? blockText[k + 1] : '');
  }
  const fits = (): boolean =>
    sides.every(fit => fit()) &&
    made.every((text, m) => {
      let given = '';
      let any = false;
      choice.forEach((o, k) => {
        if (o === m) {
          any = true;
          given += runs[k].text;
        }
      });
      return any && isSubsequence(text, given);
    });
  // A made node can take only a run its text is a subsequence of, or the
  // first of several next to each other that hold its text together.
  const takes = runs.map((r, k) =>
    made.map(
      text => isSubsequence(text, r.text) || isSubsequence(text, blockText[k]),
    ),
  );
  // Every made node needs a run; the search stops after MAX_STEPS
  // assignments tried, counting the update as inserting (never refused for
  // a character it may have typed).
  if (made.some((_t, m) => !takes.some(row => row[m]))) {
    return verdict(false, 'a made text node no removed run gives');
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
    for (const o of [
      ...made.map((_t, m) => m),
      NONE,
      LEFT,
      RIGHT,
      ...far[k].map((_p, n) => FAR - n),
    ]) {
      if (exhausted) {
        return false;
      }
      // A made node that has a run already takes this one too only where it
      // is the next of the same block (see sameBlock).
      const extending = o >= 0 && sameBlock(k) && choice[k - 1] === o;
      if (
        ((o === LEFT || o === RIGHT) && !touching(runs[k])) ||
        (o === LEFT && runs[k].left < 0) ||
        (o === RIGHT && runs[k].right < 0) ||
        (o >= 0 && !extending && (used.has(o) || !takes[k][o]))
      ) {
        continue;
      }
      choice[k] = o;
      if (o >= 0 && !extending) {
        used.add(o);
      }
      if (search(k + 1)) {
        return true;
      }
      if (o >= 0 && !extending) {
        used.delete(o);
      }
    }
    choice[k] = NONE;
    return false;
  };
  if (search(0)) {
    return verdict(true, 'every character from an old one, in order');
  }
  return exhausted
    ? verdict(false, `more than ${MAX_STEPS} assignments tried`)
    : verdict(false, 'no assignment of the removed text fits');
}

/**
 * What insertionFree finds: whether the update inserts no character, why,
 * and whether it changes any text at all (a text node's text changed, or a
 * new text node with text): one that changes none only moves, removes or
 * re-keys nodes.
 */
export type InsertionVerdict = {
  changesText: boolean;
  free: boolean;
  reason: string;
};

/**
 * Where the update's record says a removed text node's text went: merged
 * into kept node `key`, before or after its text (see insertionFree).
 */
export type Recipient = {
  key: string;
  /**
   * Where among what was merged into `key` on its side the text went, where
   * the record tells (several merged into one node, a chain of merges).
   */
  rank?: number;
  side: 'before' | 'after';
};

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
