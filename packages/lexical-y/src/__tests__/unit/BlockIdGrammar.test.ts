/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The derived block id grammar (see BlockIds.ts) is one grammar both ways:
// formatDerivedId and parseDerivedId are inverse, every id the binding
// derives parses back to the item it derives from, and the parser accepts
// exactly the strings of the grammar, which is how the block that derives
// an id is found from the id alone.

import type {Item} from '@y/y';

import {describe, expect, test} from 'vitest';

import {
  derivedBlockId,
  type DerivedId,
  formatDerivedId,
  groupSuffix,
  parseDerivedId,
  wrapperSuffix,
} from '../../internal/BlockIds';

/** The grammar, written out: y<client>_<clock>[_l | _g<n> | _w<n>](_d)*. */
const GRAMMAR = /^y[0-9a-z]+_[0-9a-z]+(?:_l|_g[0-9]*|_w[0-9]*)?(?:_d)*$/;

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomId(rng: () => number): DerivedId {
  const kinds: DerivedId['kind'][] = ['', 'l', 'g', 'w'];
  const kind = kinds[Math.floor(rng() * kinds.length)];
  return {
    // Yjs 14's client ids are 53-bit; clocks count items.
    client:
      rng() < 0.2
        ? Number.MAX_SAFE_INTEGER - Math.floor(rng() * 1000)
        : Math.floor(rng() * 2 ** 53),
    clock: rng() < 0.2 ? Math.floor(rng() * 40) : Math.floor(rng() * 2 ** 32),
    kind,
    level: kind === 'g' || kind === 'w' ? Math.floor(rng() * 70) : 0,
    repeats: Math.floor(rng() * 4),
  };
}

const item = (client: number, clock: number) =>
  ({id: {client, clock}}) as unknown as Item;

describe('derived block ids', () => {
  test('format writes the grammar', () => {
    const at = {client: 7, clock: 36, level: 0, repeats: 0};
    expect(formatDerivedId({...at, kind: ''})).toBe('y7_10');
    expect(formatDerivedId({...at, kind: 'l'})).toBe('y7_10_l');
    expect(formatDerivedId({...at, kind: 'g'})).toBe('y7_10_g');
    expect(formatDerivedId({...at, kind: 'g', level: 2})).toBe('y7_10_g2');
    expect(formatDerivedId({...at, kind: 'w'})).toBe('y7_10_w');
    expect(formatDerivedId({...at, kind: 'w', level: 12})).toBe('y7_10_w12');
    expect(formatDerivedId({...at, kind: 'g', repeats: 2})).toBe('y7_10_g_d_d');
    expect(
      formatDerivedId({...at, client: Number.MAX_SAFE_INTEGER, kind: ''}),
    ).toBe('y' + Number.MAX_SAFE_INTEGER.toString(36) + '_10');
  });

  test('parse(format(id)) gives the parts back', () => {
    const rng = random(9400);
    for (let i = 0; i < 5000; i++) {
      const id = randomId(rng);
      const text = formatDerivedId(id);
      expect(GRAMMAR.test(text)).toBe(true);
      expect(parseDerivedId(text)).toEqual({
        ...id,
        base: formatDerivedId({...id, repeats: 0}),
      });
      expect(formatDerivedId(parseDerivedId(text)!)).toBe(text);
    }
  });

  test('every id the binding derives parses back to its item', () => {
    const rng = random(14);
    for (let i = 0; i < 1000; i++) {
      const {client, clock} = randomId(rng);
      const base = derivedBlockId(item(client, clock));
      const level = Math.floor(rng() * 70);
      for (const [text, kind, lv] of [
        [base, '', 0],
        [base + '_l', 'l', 0],
        [base + groupSuffix(level), 'g', level],
        [base + wrapperSuffix(level), 'w', level],
      ] as const) {
        for (let repeats = 0; repeats < 3; repeats++) {
          const id = text + '_d'.repeat(repeats);
          expect(parseDerivedId(id)).toEqual({
            base: text,
            client,
            clock,
            kind,
            level: lv,
            repeats,
          });
          expect(formatDerivedId(parseDerivedId(id)!)).toBe(id);
        }
      }
    }
  });

  test('parse accepts exactly the grammar', () => {
    for (const text of [
      '',
      'y',
      'y1',
      'y1_',
      'y_1',
      'Y1_2',
      'x1_2',
      ' y1_2',
      'y1_2 ',
      'y1_2_',
      'y1_2_x',
      'y1_2_l3',
      'y1_2_ld',
      'y1_2_d_g',
      'y1_2_g_l',
      'y1_2_gw',
      'y1_2_g_w',
      'y1_2__d',
      'y-1_2',
      'y1.5_2',
    ]) {
      expect(GRAMMAR.test(text)).toBe(false);
      expect(parseDerivedId(text)).toBe(null);
    }
    // Forms formatDerivedId does not write still parse: only `base` names
    // them (no block derives `y1_2_g0`, whose level 0 is written `_g`).
    expect(parseDerivedId('y01_2')).toEqual({
      base: 'y01_2',
      client: 1,
      clock: 2,
      kind: '',
      level: 0,
      repeats: 0,
    });
    expect(parseDerivedId('y1_2_g0_d')).toEqual({
      base: 'y1_2_g0',
      client: 1,
      clock: 2,
      kind: 'g',
      level: 0,
      repeats: 1,
    });
    // Random strings over the grammar's alphabet: the parser accepts those
    // the grammar describes, and splits them as it does.
    const rng = random(2026);
    const pieces = ['y', '_', '1', '2', 'z', '0', 'g', 'w', 'l', 'd', '_d'];
    let accepted = 0;
    for (let i = 0; i < 20000; i++) {
      let text = rng() < 0.7 ? 'y' : '';
      const n = 1 + Math.floor(rng() * 10);
      for (let k = 0; k < n; k++) {
        text += pieces[Math.floor(rng() * pieces.length)];
      }
      const parsed = parseDerivedId(text);
      expect(parsed !== null).toBe(GRAMMAR.test(text));
      if (parsed !== null) {
        accepted++;
        const [client, clock] = parsed.base.slice(1).split('_');
        expect(parsed.client).toBe(parseInt(client, 36));
        expect(parsed.clock).toBe(parseInt(clock, 36));
        expect(parsed.base + '_d'.repeat(parsed.repeats)).toBe(text);
      }
    }
    expect(accepted).toBeGreaterThan(100);
  });
});
