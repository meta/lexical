/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Shared pieces of the randomized lanes (see unit/LaneFuzz.test.ts): a seeded
// PRNG, the storage checks every lane runs on every document, a character
// alignment, and a delta-debugging shrinker over a lane's explicit history.

import type {Peer} from '../harness';

import * as Y from '@y/y';

import {misLinkedItems} from '../structure';

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(r: () => number, values: readonly T[]): T {
  return values[Math.floor(r() * values.length)];
}

/** One failed check: `cls` groups failures, `detail` says where. */
export type Finding = {cls: string; detail: string};

/**
 * A history is explicit: every choice the generator made is in `cfg`, so a
 * repro replays without the generator and a shrunk history is just a smaller
 * `cfg`.
 */
export type LaneHistory<C> = {
  lane: string;
  seed: number;
  gc: boolean;
  ids: number[];
  cfg: C;
};

export interface Lane<C> {
  readonly name: string;
  generate(seed: number, gc: boolean): LaneHistory<C>;
  run(history: LaneHistory<C>): Promise<Finding[]>;
  /** Smaller variants of a history, the most aggressive first. */
  simplify(history: LaneHistory<C>): LaneHistory<C>[];
}

/** Runs a history, turning a throw into a finding. */
export async function runSafe<C>(
  lane: Lane<C>,
  history: LaneHistory<C>,
): Promise<Finding[]> {
  try {
    return await lane.run(history);
  } catch (e) {
    return [{cls: 'crash', detail: String(e).slice(0, 300)}];
  }
}

/**
 * Delta debugging over a history's explicit choices: take the first variant
 * from `simplify` that still fails with `cls`, and start again from it, until
 * no variant fails or the budget is spent.
 */
export async function shrink<C>(
  lane: Lane<C>,
  history: LaneHistory<C>,
  cls: string,
  budget: number,
): Promise<{history: LaneHistory<C>; findings: Finding[]; runs: number}> {
  let current = history;
  let findings: Finding[] = [];
  let runs = 0;
  let progressed = true;
  while (progressed && runs < budget) {
    progressed = false;
    for (const candidate of lane.simplify(current)) {
      if (runs >= budget) {
        break;
      }
      runs++;
      const found = await runSafe(lane, candidate);
      if (found.some(f => f.cls === cls)) {
        current = candidate;
        findings = found;
        progressed = true;
        break;
      }
    }
  }
  return {findings, history: current, runs};
}

/**
 * Variants of `cfg` with one field set to its neutral value, for the fields
 * whose value differs from it.
 */
export function neutralVariants<C extends object>(
  cfg: C,
  neutral: Partial<C>,
): C[] {
  const out: C[] = [];
  for (const key of Object.keys(neutral) as (keyof C)[]) {
    if (JSON.stringify(cfg[key]) !== JSON.stringify(neutral[key])) {
      out.push({...cfg, [key]: neutral[key]});
    }
  }
  return out;
}

/** Each variant of `list` with one element removed. */
export function dropOne<T>(list: readonly T[]): T[][] {
  return list.map((_, i) => [...list.slice(0, i), ...list.slice(i + 1)]);
}

// ---------------------------------------------------------------------------
// Storage checks

// Layout 3's covered keys (DECISIONS D101): text formats, wrappers, text
// fields, a text node's type and segment, and set-valued NodeState members.
function isCovered(key: string): boolean {
  if (key.length === 1) {
    return key === 't' || key === 'k';
  }
  if (key[1] !== ':') {
    return false;
  }
  const c = key[0];
  return (
    c === 'f' || c === 'p' || c === 'w' || (c === 's' && key.includes('\u001f'))
  );
}

function endTarget(item: Y.Item, value: unknown[]): string | null {
  const ok = (x: unknown, min: number) =>
    typeof x === 'number' && Number.isSafeInteger(x) && x >= min;
  if (value.length === 1 && ok(value[0], 1)) {
    const clock = item.id.clock - (value[0] as number);
    return clock >= 0 ? `${item.id.client}:${clock}` : null;
  }
  if (value.length === 2 && ok(value[0], 0) && ok(value[1], 0)) {
    return `${value[0]}:${value[1]}`;
  }
  return null;
}

/**
 * The paired-run grammar of layout 3, strictly: in every container, every
 * live end of a covered key names a live opener of the same key before it,
 * and every live opener has such an end. The binding writes nothing else
 * (raw writes, which may, are unsupported by D109).
 */
export function pairedRunHits(doc: Y.Doc): string[] {
  const containers = new Set<unknown>();
  for (const structs of doc.store.clients.values()) {
    for (const s of structs) {
      if (s instanceof Y.Item && s.parentSub === null && s.parent) {
        containers.add(s.parent);
      }
    }
  }
  const hits: string[] = [];
  for (const container of containers) {
    const openers = new Map<string, Y.Item>();
    const paired = new Set<string>();
    for (
      let it = (container as unknown as {_start: Y.Item | null})._start;
      it !== null;
      it = it.right
    ) {
      if (it.deleted || !(it.content instanceof Y.ContentFormat)) {
        continue;
      }
      const {key, value} = it.content as unknown as {
        key: string;
        value: unknown;
      };
      if (!isCovered(key)) {
        continue;
      }
      const id = `${it.id.client}:${it.id.clock}`;
      if (Array.isArray(value) && value.length > 0) {
        const target = endTarget(it, value);
        const opener = target === null ? undefined : openers.get(target);
        if (
          opener === undefined ||
          (opener.content as unknown as {key: string}).key !== key
        ) {
          hits.push(`dangling end ${key} ${id} -> ${target}`);
        } else {
          paired.add(target!);
        }
      } else {
        openers.set(id, it);
      }
    }
    for (const [id, opener] of openers) {
      if (!paired.has(id)) {
        const {key, value} = opener.content as unknown as {
          key: string;
          value: unknown;
        };
        hits.push(`unpaired opener ${key}=${JSON.stringify(value)} ${id}`);
      }
    }
  }
  return hits;
}

/** Storage and editor health of one peer: each problem as a finding. */
export function peerFindings(peer: Peer, label: string): Finding[] {
  const out: Finding[] = [];
  for (const e of peer.errors) {
    out.push({cls: 'editor-error', detail: `${label}: ${String(e)}`});
  }
  for (const w of peer.warnings) {
    if (w.includes('self-check')) {
      out.push({cls: 'self-check', detail: `${label}: ${w.slice(0, 200)}`});
    } else if (w.includes('could not be written')) {
      out.push({cls: 'recovered-write', detail: `${label}: ${w}`});
    }
  }
  for (const id of misLinkedItems(peer.doc)) {
    out.push({cls: 'storage-structure', detail: `${label}: item ${id}`});
  }
  for (const hit of pairedRunHits(peer.doc)) {
    out.push({cls: 'storage-paired-runs', detail: `${label}: ${hit}`});
  }
  return out;
}

/** Every view equal to the first (peers and a fresh reader). */
export function convergenceFindings(
  views: {type: string; chars: Record<string, unknown>[]}[][],
  labels: string[],
): Finding[] {
  const out: Finding[] = [];
  const first = views[0];
  const describe = (b: (typeof first)[number] | undefined) =>
    b === undefined ? 'nothing' : `${b.type} ${describeChars(b.chars)}`;
  views.forEach((view, i) => {
    if (JSON.stringify(view) === JSON.stringify(first)) {
      return;
    }
    // The first block that differs.
    let at = 0;
    while (JSON.stringify(view[at]) === JSON.stringify(first[at])) {
      at++;
    }
    out.push({
      cls: 'divergence',
      detail: `block ${at}: ${labels[i]} ${describe(view[at])}; ${labels[0]} ${describe(first[at])}`,
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Alignment

/**
 * An alignment of two strings as difflib's matcher makes it: the longest
 * common run first, then the same on each side of it. For each index of `b`
 * in a matched character, the index of `a` it matches. Matching whole runs
 * first keeps a block's text matched to itself rather than to equal
 * characters elsewhere.
 */
export function align(a: string, b: string): Map<number, number> {
  const out = new Map<number, number>();
  const visit = (a0: number, a1: number, b0: number, b1: number) => {
    let best = 0;
    let bi = a0;
    let bj = b0;
    // run[j] is the length of the common run ending at a[i - 1], b[j - 1].
    let prev = new Uint16Array(b1 - b0 + 1);
    for (let i = a0; i < a1; i++) {
      const run = new Uint16Array(b1 - b0 + 1);
      for (let j = b0; j < b1; j++) {
        if (a[i] === b[j]) {
          const len = prev[j - b0] + 1;
          run[j - b0 + 1] = len;
          if (len > best) {
            best = len;
            bi = i - len + 1;
            bj = j - len + 1;
          }
        }
      }
      prev = run;
    }
    if (best === 0) {
      return;
    }
    visit(a0, bi, b0, bj);
    for (let k = 0; k < best; k++) {
      out.set(bj + k, bi + k);
    }
    visit(bi + best, a1, bj + best, b1);
  };
  visit(0, a.length, 0, b.length);
  return out;
}

/**
 * A character of a lane's view: `ch` and the attributes the lane judges,
 * with its block's index and type.
 */
export type FlatChar = {ch: string; block: number; btype: string} & Record<
  string,
  unknown
>;
export type Change =
  | {
      kind: 'attr';
      at: number | null;
      char: FlatChar;
      after: FlatChar;
      attr: string;
      from: unknown;
      to: unknown;
    }
  | {kind: 'del'; at: number | null; ch: string}
  | {kind: 'ins'; at: number | null; ch: string; char: FlatChar}
  /**
   * A block boundary removed (two blocks joined) or inserted (a block
   * split); `block` is the block of `ref` it is in or ends (`null` when it
   * maps to none).
   */
  | {
      kind: 'boundary';
      at: number | null;
      op: 'del' | 'ins';
      block: number | null;
    };

/**
 * A lane's block view, flattened with `null` after each block; each
 * character carries its block's index, type and alignment (`bformat`).
 */
export function flatten(
  blocks: {type: string; format?: string; chars: Record<string, unknown>[]}[],
): (FlatChar | null)[] {
  const out: (FlatChar | null)[] = [];
  blocks.forEach((b, block) => {
    for (const c of b.chars) {
      out.push({
        ...c,
        bformat: b.format ?? '',
        block,
        btype: b.type,
      } as unknown as FlatChar);
    }
    out.push(null);
  });
  return out;
}

/**
 * A block boundary in the aligned text: a character no view holds, so a
 * boundary never aligns with content (an inline line break is '\n').
 */
const BOUNDARY = '\u0001';
const textOf = (v: (FlatChar | null)[]) =>
  v.map(c => (c === null ? BOUNDARY : c.ch)).join('');

/**
 * What one write changed, from `before` to `after` (flattened stored views),
 * each change placed on the character of `ref` it maps to (`at`; `null` when
 * it maps to none). An inserted character is placed on the nearest matched
 * character before it.
 */
export function changesOf(
  ref: (FlatChar | null)[],
  before: (FlatChar | null)[],
  after: (FlatChar | null)[],
  attrs: readonly string[],
): Change[] {
  const toRef = align(textOf(ref), textOf(before));
  const ba = align(textOf(before), textOf(after));
  const out: Change[] = [];
  const matched = new Set<number>();
  for (const [j, i] of ba) {
    matched.add(i);
    const b = before[i];
    const a = after[j];
    if (b === null || a === null) {
      continue;
    }
    for (const attr of [...attrs, 'btype']) {
      if (JSON.stringify(b[attr]) !== JSON.stringify(a[attr])) {
        out.push({
          after: a,
          at: toRef.get(i) ?? null,
          attr,
          char: b,
          from: b[attr],
          kind: 'attr',
          to: a[attr],
        });
      }
    }
  }
  // The block of `ref` a position is in, or ends when it is a boundary.
  const blockAt = (at: number | null): number | null => {
    if (at === null) {
      return null;
    }
    const c = ref[at];
    return c === null
      ? ref.slice(0, at).filter(x => x === null).length
      : c.block;
  };
  before.forEach((c, i) => {
    if (!matched.has(i)) {
      const at = toRef.get(i) ?? null;
      out.push(
        c === null
          ? {at, block: blockAt(at), kind: 'boundary', op: 'del'}
          : {at, ch: c.ch, kind: 'del'},
      );
    }
  });
  after.forEach((c, j) => {
    if (!ba.has(j)) {
      let k = j - 1;
      while (k >= 0 && !ba.has(k)) {
        k--;
      }
      const at = k >= 0 ? (toRef.get(ba.get(k)!) ?? null) : null;
      out.push(
        c === null
          ? {at, block: blockAt(at), kind: 'boundary', op: 'ins'}
          : {at, ch: c.ch, char: c, kind: 'ins'},
      );
    }
  });
  return out;
}

/**
 * A block's characters written compactly: each run of characters with equal
 * attributes as its text and the attributes.
 */
export function describeChars(
  chars: readonly Record<string, unknown>[],
): string {
  const out: string[] = [];
  let text = '';
  let sig: string | null = null;
  const flush = () => {
    if (sig !== null) {
      out.push(`${JSON.stringify(text)}${sig}`);
    }
  };
  for (const {ch, ...rest} of chars) {
    const s = JSON.stringify(rest);
    if (s !== sig) {
      flush();
      text = '';
      sig = s;
    }
    text += String(ch);
  }
  flush();
  return out.join(' ');
}

/** LANE_TRACE=1: logs each peer's document at a step of a history. */
export function trace(step: string, peers: Record<string, Peer>) {
  if (process.env.LANE_TRACE === '1') {
    // eslint-disable-next-line no-console
    console.log(
      [
        `-- ${step}`,
        ...Object.entries(peers).map(([k, p]) => `  ${k}: ${p.describe()}`),
      ].join('\n'),
    );
  }
}
