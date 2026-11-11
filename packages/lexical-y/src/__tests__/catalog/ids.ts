/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The block id catalog: every format a block id takes in practice. Handles,
// indexes and anything else that reads ids must hold for every one of them,
// not only for random ids:
//
// - `random`: BlockIdExtension's generateBlockId (21 base64url characters);
// - `positional`: what BlockIdExtension derives for a document stored without
//   ids (a hash of the document and the block's place: random-looking, but
//   the same on every reader). Built from a document, see `$positional` in the
//   matrix; `ids()` gives look-alikes;
// - `derived`: `@lexical/y`'s ids for blocks without a stored id,
//   `y<client>_<clock>` in base 36: one shared prefix per client, sequential
//   clocks (see BlockIds.ts);
// - `derived-suffixed`: the same with the `_g`, `_g<level>`, `_w`, `_l` and
//   `_d` suffixes (groups, wrappers, lines whose first item is a stored
//   node, repeats);
// - `duplicate-repair`: ids that repeat another block's, as a paste or a
//   concurrent copy leaves them, which a reader repairs (`_d` for derived
//   ids; a new id from the extension otherwise);
// - `uuidv7`: app-supplied UUIDv7 (RFC 9562): timestamp first, so ids minted
//   close together share a long prefix;
// - `counter`: app-supplied `b1`, `b2`, ...;
// - `legacy-b36`: app-supplied `b` + base 36 (a timestamp and a counter);
// - `mixed`: one document holding all of the above.

/** A deterministic PRNG (mulberry32), so every run draws the same ids. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE64URL =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function randomString(rand: () => number, length: number): string {
  let id = '';
  for (let i = 0; i < length; i++) {
    id += BASE64URL[Math.floor(rand() * 64)];
  }
  return id;
}

export type IdFormat =
  | 'random'
  | 'positional'
  | 'derived'
  | 'derived-suffixed'
  | 'duplicate-repair'
  | 'uuidv7'
  | 'counter'
  | 'legacy-b36'
  | 'mixed';

export interface IdFormatEntry {
  readonly format: IdFormat;
  readonly description: string;
  /**
   * `n` distinct ids of this format (for `duplicate-repair`, ids where some
   * repeat an earlier one), deterministic for `seed`.
   */
  readonly ids: (n: number, seed: number) => string[];
  /** Whether every id is distinct. */
  readonly distinct: boolean;
}

/** `y<client>_<clock>` as `@lexical/y` writes it. */
export function derivedId(client: number, clock: number): string {
  return 'y' + client.toString(36) + '_' + clock.toString(36);
}

/**
 * Derived ids of one client's blocks: sequential clocks, each block's
 * marker after its text (a block of 5 to 40 characters takes that many
 * clocks and one more).
 */
function derivedIds(n: number, seed: number, clients = 1): string[] {
  const rand = prng(seed);
  const ids: string[] = [];
  const clientIds = Array.from(
    {length: clients},
    () => Math.floor(rand() * 0xffffffff) >>> 0,
  );
  const clocks = clientIds.map(() => Math.floor(rand() * 50));
  for (let i = 0; i < n; i++) {
    const c = i % clients;
    clocks[c] += 1 + 5 + Math.floor(rand() * 36);
    ids.push(derivedId(clientIds[c], clocks[c]));
  }
  return ids;
}

const SUFFIXES = ['', '_g', '_g1', '_g2', '_w', '_w1', '_l', '_d', '_g_d'];

function uuidv7(ms: number, rand: () => number): string {
  const hex = (value: number, digits: number) =>
    Math.floor(value).toString(16).padStart(digits, '0');
  const time = hex(ms, 12);
  const randA = hex(rand() * 0x1000, 3);
  const variant = hex(0x8000 + rand() * 0x4000, 4);
  const randB = hex(rand() * 0x1000000, 6) + hex(rand() * 0x1000000, 6);
  return `${time.slice(0, 8)}-${time.slice(8)}-7${randA}-${variant}-${randB}`;
}

export const ID_FORMATS: readonly IdFormatEntry[] = [
  {
    description: 'generateBlockId: 21 random base64url characters',
    distinct: true,
    format: 'random',
    ids: (n, seed) => {
      const rand = prng(seed);
      return Array.from({length: n}, () => randomString(rand, 21));
    },
  },
  {
    description:
      'positional ids of a document stored without ids (look-alikes: 21 hashed base64url characters)',
    distinct: true,
    format: 'positional',
    ids: (n, seed) => {
      const rand = prng(seed ^ 0x5eed);
      return Array.from({length: n}, () => randomString(rand, 21));
    },
  },
  {
    description: '@lexical/y derived ids y<client>_<clock>, one client',
    distinct: true,
    format: 'derived',
    ids: (n, seed) => derivedIds(n, seed),
  },
  {
    description:
      '@lexical/y derived ids of three clients with _g/_w/_l/_d suffixes',
    distinct: true,
    format: 'derived-suffixed',
    ids: (n, seed) => {
      const rand = prng(seed + 1);
      return derivedIds(n, seed, 3).map(
        id => id + SUFFIXES[Math.floor(rand() * SUFFIXES.length)],
      );
    },
  },
  {
    description:
      'ids repeated by a paste or a concurrent copy: every fourth id repeats an earlier one',
    distinct: false,
    format: 'duplicate-repair',
    ids: (n, seed) => {
      const rand = prng(seed);
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        ids.push(
          i % 4 === 3 ? ids[Math.floor(rand() * i)] : randomString(rand, 21),
        );
      }
      return ids;
    },
  },
  {
    description:
      'UUIDv7: 48-bit millisecond timestamp first; minted a few ms apart',
    distinct: true,
    format: 'uuidv7',
    ids: (n, seed) => {
      const rand = prng(seed);
      let ms = 1793358000000 + Math.floor(rand() * 1000);
      return Array.from({length: n}, () => {
        ms += Math.floor(rand() * 3);
        return uuidv7(ms, rand);
      });
    },
  },
  {
    description: 'counters b1, b2, ...',
    distinct: true,
    format: 'counter',
    ids: n => Array.from({length: n}, (_, i) => `b${i + 1}`),
  },
  {
    description: "legacy 'b' + base 36 of a timestamp and a counter",
    distinct: true,
    format: 'legacy-b36',
    ids: (n, seed) => {
      const base = 1793358000000 + seed;
      return Array.from(
        {length: n},
        (_, i) => 'b' + (base + i * 7).toString(36) + i.toString(36),
      );
    },
  },
  {
    description: 'one document holding every other format',
    distinct: true,
    format: 'mixed',
    ids: (n, seed) => {
      const others = ID_FORMATS.filter(f => f.format !== 'mixed' && f.distinct);
      const per = Math.ceil(n / others.length);
      const all = others.flatMap((f, i) => f.ids(per, seed + i));
      const rand = prng(seed);
      // A fixed shuffle, so formats interleave in document order.
      for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [all[i], all[j]] = [all[j], all[i]];
      }
      return Array.from(new Set(all)).slice(0, n);
    },
  },
];

/** The entry for `format`. */
export function idFormat(format: IdFormat): IdFormatEntry {
  const found = ID_FORMATS.find(f => f.format === format);
  if (found === undefined) {
    throw new Error(`catalog: no id format ${format}`);
  }
  return found;
}
