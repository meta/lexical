/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The lanes' oracles (utils/lanes, run by LaneFuzz.test) report what they
// are meant to: each case is a stored view before and after the ending
// phase that a lane must flag, next to one it must let through.

import {describe, expect, test} from 'vitest';

import {
  type BlockConvConfig,
  endingPhase,
  generate,
  NEUTRAL,
  type View,
} from '../utils/lanes/blockconv';
import {changesOf, flatten} from '../utils/lanes/common';

const block = (type: string, text: string, format = ''): View[number] => ({
  chars: [...text].map(ch => ({ch, fmt: 0, kind: 'text', note: '', pnote: ''})),
  format,
  type,
});

const cfg = (over: Partial<BlockConvConfig>): BlockConvConfig => ({
  ...generate(1, false).cfg,
  ...NEUTRAL,
  ...over,
});

const PRE: View = [
  block('paragraph', 'intro'),
  block('heading', 'see word'),
  block('paragraph', 'let untouched = 1;'),
];

// `ran`: whether the composer's release transform changed the held heading
// in the ending phase.
const classes = (
  c: Partial<BlockConvConfig>,
  after: View,
  pre = PRE,
  ran = false,
) => endingPhase(cfg(c), pre, after, ran).map(f => f.cls);

const n = (count: number, cls: string) => Array(count).fill(cls);

describe('changesOf', () => {
  test('reports a block boundary removed or added', () => {
    const two = flatten([block('paragraph', 'ab'), block('paragraph', 'cd')]);
    const one = flatten([block('paragraph', 'abcd')]);
    expect(changesOf(two, two, one, [])).toEqual([
      expect.objectContaining({kind: 'boundary', op: 'del'}),
    ]);
    expect(changesOf(one, one, two, [])).toEqual([
      expect.objectContaining({kind: 'boundary', op: 'ins'}),
    ]);
  });
});

describe("blockconv's ending-phase invariant", () => {
  const paragraphs = [
    block('paragraph', 'intro'),
    block('paragraph', 'see word'),
    block('paragraph', 'let untouched = 1;'),
  ];

  test('flags a block boundary nothing asked to remove', () => {
    // The held paragraph joined into the untouched one after it: every
    // character keeps its attributes and block type.
    const joined = [
      paragraphs[0],
      block('paragraph', 'see wordlet untouched = 1;'),
    ];
    expect(classes({}, joined, paragraphs)).toEqual(['ending-phase-boundary']);
    // The collaborator deleted the held line: one boundary goes with it.
    expect(
      classes({deleteHeld: true}, [paragraphs[0], paragraphs[2]], paragraphs),
    ).toEqual([]);
  });

  test('flags a block boundary turned into an inline line break', () => {
    const joined = block('paragraph', 'see word\nlet untouched = 1;');
    joined.chars[8] = {...joined.chars[8], kind: 'linebreak'};
    expect(classes({}, [paragraphs[0], joined], paragraphs)).toEqual([
      'ending-phase-boundary',
      'ending-phase-text',
    ]);
  });

  test('flags a block split outside what a delete accounts for', () => {
    expect(
      classes({}, [
        PRE[0],
        PRE[1],
        block('paragraph', 'let '),
        block('paragraph', 'untouched = 1;'),
      ]),
    ).toEqual(['ending-phase-boundary']);
  });

  test('lets the ending update type what it types, in the held line only', () => {
    const held = (text: string) => [PRE[0], block('heading', text), PRE[2]];
    expect(classes({endInsert: true}, held('see word z'))).toEqual([]);
    expect(classes({endInsert: true}, held('see wordCORRUPTION'))).toEqual(
      n(10, 'ending-phase-text'),
    );
    // The same text typed at the start of another block.
    expect(
      classes({endInsert: true}, [
        block('paragraph', ' zintro'),
        PRE[1],
        PRE[2],
      ]),
    ).toEqual(n(2, 'ending-phase-text'));
  });

  test("lets a held line's text survive its delete, and nothing more", () => {
    // The ending update's typed text joins the next line.
    expect(
      classes({deleteHeld: true, endInsert: true}, [
        PRE[0],
        block('paragraph', ' zlet untouched = 1;'),
      ]),
    ).toEqual([]);
    expect(
      classes({deleteHeld: true}, [
        block('paragraph', 'intro' + 'CORRUPTION'.repeat(20)),
        PRE[2],
      ]),
    ).toEqual(expect.arrayContaining(['ending-phase-text']));
  });

  test('lets an upper-casing transform upper-case headings and quotes only', () => {
    const upper = (held: string) => [PRE[0], block('heading', held), PRE[2]];
    expect(classes({parentXform: 'upper'}, upper('SEE WORD'))).toEqual([]);
    expect(classes({parentXform: 'upper'}, upper('SEE WORDWORD'))).toEqual(
      n(4, 'ending-phase-text'),
    );
    expect(
      classes({parentXform: 'upper'}, [
        block('paragraph', 'INTRO'),
        PRE[1],
        PRE[2],
      ]),
    ).toEqual(n(5, 'ending-phase-other-block'));
  });

  test("flags another block's type or alignment changing", () => {
    expect(classes({}, [block('quote', 'intro'), PRE[1], PRE[2]])).toEqual(
      n(5, 'ending-phase-other-block'),
    );
    expect(
      classes({}, [block('paragraph', 'intro', 'center'), PRE[1], PRE[2]]),
    ).toEqual(n(5, 'ending-phase-other-block'));
    expect(
      classes({}, [PRE[0], block('heading', 'see word', 'center'), PRE[2]]),
    ).toEqual(n(8, 'ending-phase-block-format'));
  });

  test('lets a release transform that ran do what it does, and nothing more', () => {
    const ran = (c: Partial<BlockConvConfig>, after: View) =>
      classes(c, after, PRE, true);
    // Replace: the held heading becomes a paragraph, without alignment.
    const replaced = [PRE[0], block('paragraph', 'see word'), PRE[2]];
    expect(ran({relxform: 'replace'}, replaced)).toEqual([]);
    expect(classes({relxform: 'replace'}, replaced)).toEqual(
      n(8, 'ending-phase-block-type'),
    );
    expect(
      ran({relxform: 'replace'}, [PRE[0], block('quote', 'see word'), PRE[2]]),
    ).toEqual(n(8, 'ending-phase-block-type'));
    expect(
      ran({relxform: 'replace'}, [
        block('quote', 'intro'),
        replaced[1],
        PRE[2],
      ]),
    ).toEqual(n(5, 'ending-phase-other-block'));
    // Unwrap: the held heading joins the paragraph before it.
    expect(
      ran({relxform: 'unwrap'}, [block('paragraph', 'introsee word'), PRE[2]]),
    ).toEqual([]);
    // Split: boundaries in the held line only.
    expect(
      ran({relxform: 'split'}, [
        PRE[0],
        block('heading', 'see '),
        block('paragraph', 'word'),
        PRE[2],
      ]),
    ).toEqual([]);
    expect(
      ran({relxform: 'split'}, [
        PRE[0],
        PRE[1],
        block('paragraph', 'let '),
        block('paragraph', 'untouched = 1;'),
      ]),
    ).toEqual(['ending-phase-boundary']);
    // Upper-case: the held line's letters only.
    const upper = [PRE[0], block('heading', 'SEE WORD'), PRE[2]];
    expect(ran({relxform: 'upper'}, upper)).toEqual([]);
    expect(classes({relxform: 'upper'}, upper)).toEqual(
      n(14, 'ending-phase-text'),
    );
    // Trailing '!': one.
    const bang = (text: string) => [PRE[0], block('heading', text), PRE[2]];
    expect(ran({relxform: 'bang'}, bang('see word!'))).toEqual([]);
    expect(ran({relxform: 'bang'}, bang('see !!!word!!!'))).toEqual(
      n(5, 'ending-phase-text'),
    );
  });

  test('lets a code highlighter turn a decorator into its text, only where there was one', () => {
    const withDecor = [
      PRE[0],
      {
        ...block('heading', 'see word'),
        chars: [
          ...block('heading', 'see word').chars,
          {ch: '\uFFFC', fmt: 0, kind: 'decorator', note: '', pnote: ''},
        ],
      },
      PRE[2],
    ];
    const code = (text: string) => [PRE[0], block('code', text), PRE[2]];
    const c = {highlighter: 'Prism', relxform: 'replace-code'} as const;
    expect(classes(c, code('see wordx^2'), withDecor, true)).toEqual([]);
    expect(classes(c, code('see wordxxxx2222^^^^'), PRE, true)).toEqual(
      n(12, 'ending-phase-text'),
    );
  });

  test('lets an autolink rewrite its text only where autolinks are on', () => {
    const linked = block('heading', 'see word');
    linked.chars = linked.chars.map(c => ({
      ...c,
      fmt: 1,
      kind: 'autolink>text',
    }));
    expect(
      classes({autolink: false}, [PRE[0], linked, PRE[2]]).length,
    ).toBeGreaterThan(0);
    expect(classes({autolink: true}, [PRE[0], linked, PRE[2]])).toEqual([]);
    // It rewrites text, not the block's type.
    expect(
      classes({autolink: true}, [PRE[0], {...linked, type: 'quote'}, PRE[2]]),
    ).toEqual(n(8, 'ending-phase-block-type'));
  });
});
