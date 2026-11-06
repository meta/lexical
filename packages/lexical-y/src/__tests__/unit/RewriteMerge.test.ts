/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A rewrite of most of a line (an agent's setTextContent, a paste over a
// selection) racing a peer's typing in the same line: replaced words are
// replaced whole, so the peer's text never lands inside a word (found by
// agent soak runs: `agent_000632followup_0006282 … 3`, `Rverify_… ewritten`).
// @vitest-environment node

import type {TextNode} from 'lexical';

import {$createParagraphNode, $createTextNode, $getRoot} from 'lexical';
import {describe, expect, test} from 'vitest';

import {snapToWords} from '../../internal/Inline';
import {$block, $p, $selectIn, expectConverged, setup} from '../utils/harness';

// Peers: [author of the line, human, agent]. Where concurrent text lands
// depends on the order of client ids, so every order is run.
const IDS = [
  [1, 2, 3],
  [1, 3, 2],
  [2, 1, 3],
  [2, 3, 1],
  [3, 1, 2],
  [3, 2, 1],
];

const words = (s: string) => s.split(/\s+/).filter(w => w !== '');

type Case = [
  name: string,
  old: string,
  // Where the human types: an offset, or the start of the given word.
  at: number | string,
  typed: string,
  replacement: string,
];

const REWRITES: Case[] = [
  [
    'end of line',
    'Status: owner will verify timing. ',
    34,
    'Human adds a note. ',
    'Status: done, shipped on Friday. ',
  ],
  [
    'before a replaced word',
    'Status: owner will verify timing. ',
    'timing',
    'Human adds a note. ',
    'Status: done, shipped on Friday. ',
  ],
  [
    'before a kept word',
    'Deadline moved to Thursday 1043. ',
    '1043',
    'urgent ',
    'Deadline confirmed for 3pm 1043. ',
  ],
  [
    'shared first letter',
    'Risk 1: owner will verify timing. ',
    'will',
    'verify_0004307 ',
    'Rewritten by agent: done. ',
  ],
  [
    'shared digits inside a word',
    'Rewritten by agent: agent_0006321 review_0006280 ',
    'review_0006280',
    'followup_0006282 ',
    'Rewritten by agent: agent_0006323 handoff_0006285 ',
  ],
  [
    'shared digits, typed before a word',
    'Agent decision 7177. verify_1 ',
    'verify_1',
    'verify_0000736 ',
    'Agent decision 7178. note_2 ',
  ],
  [
    'typed after a kept word',
    'Agent decision 7177. verify_1 ',
    14,
    ' soon',
    'Agent decision 7178. note_2 ',
  ],
  [
    'typed after a replaced word',
    'Status: owner will verify timing. ',
    'will',
    ' soon',
    'Status: done, shipped on Friday. ',
  ],
];

describe.each(IDS.map(ids => [ids]))('ids %j', ids => {
  test.each(REWRITES)(
    'agent rewrite ‖ human typing (%s)',
    async (_name, old, at, typed, replacement) => {
      const t = await setup(() => $getRoot().append($p(old)), {ids});
      const [, human, agent] = t.peers;
      const offset = typeof at === 'number' ? at : old.indexOf(at);
      t.offline();
      human.update(() => {
        $selectIn([0], offset).insertText(typed);
      });
      agent.update(() => {
        const texts = $block([0]).getAllTextNodes();
        (texts[0] as TextNode).setTextContent(replacement);
        texts.slice(1).forEach(x => x.remove());
      });
      await t.sync();
      await expectConverged(t.peers);
      const merged = t.a.read(() => $getRoot().getTextContent());
      // Each side's text stays in one piece: the human's text whole, and
      // no word of either side cut. The human's text lands at the start of
      // the rewritten text; when the human typed the space before their
      // words (` soon`), nothing separates them from the rewrite's first
      // word (`soondone,`, as before), so only "not cut" is checked there.
      expect(merged).toContain(typed.trim());
      const tokens = new Set(words(merged));
      const whole = /\s$/.test(typed);
      for (const w of [...words(replacement), ...words(typed)]) {
        const ok = whole ? tokens.has(w) : merged.includes(w);
        expect(ok, JSON.stringify({merged, w})).toBe(true);
      }
    },
  );

  // The same through the general line write (the line's children change).
  // The rewrite sets the first node whole and removes the others: the space
  // that node's old and new text end with is kept (see TextLineages), so
  // the human's text, typed in a removed node after it, lands after the new
  // text, in one piece.
  test('agent rewrite of a line with a bold word ‖ human typing', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode('Risk 1: owner '),
            $createTextNode('will').toggleFormat('bold'),
            $createTextNode(' verify timing. '),
          ),
        ),
      {ids},
    );
    const [, human, agent] = t.peers;
    t.offline();
    human.update(() => {
      $selectIn([0], 19).insertText('verify_0004307 ');
    });
    agent.update(() => {
      const texts = $block([0]).getAllTextNodes();
      texts[0].setTextContent('Rewritten by agent: done. ');
      texts.slice(1).forEach(x => x.remove());
    });
    await t.sync();
    await expectConverged(t.peers);
    const merged = t.a.read(() => $getRoot().getTextContent());
    expect(merged).toBe('Rewritten by agent: done. verify_0004307 ');
  });

  // Two replacements of one word at once: each keeps its new word whole
  // (a character diff would keep a different part of the old word on each
  // side, which the other side deletes: `agent_001163640`, `verifiesied`).
  test.each([
    [
      'two rewrites of a line',
      'Rewritten by agent: agent_0011574 ',
      'agent_0011574',
      'agent_0011634',
      'agent_0011640',
    ],
    [
      'typing over the same selected word',
      'Please verify the rollout. ',
      'verify',
      'verified',
      'verifies',
    ],
  ])(
    'concurrent replacements of one word (%s)',
    async (_name, old, word, x, y) => {
      const t = await setup(() => $getRoot().append($p(old)), {ids});
      const [, human, agent] = t.peers;
      const at = old.indexOf(word);
      t.offline();
      human.update(() => {
        $selectIn([0], at, at + word.length).insertText(x);
      });
      agent.update(() => {
        $selectIn([0], at, at + word.length).insertText(y);
      });
      await t.sync();
      await expectConverged(t.peers);
      const merged = t.a.read(() => $getRoot().getTextContent());
      expect(merged.includes(x) && merged.includes(y), merged).toBe(true);
      expect(merged).not.toContain(word.slice(-2) + ' ');
    },
  );

  // Text written without spaces between words is not widened: a replaced
  // character stays a character, and a peer's typing next to it stays put.
  test('a replacement in text without spaces (Japanese) ‖ typing', async () => {
    const old = '今日は良い天気です。';
    const t = await setup(() => $getRoot().append($p(old)), {ids});
    const [, human, agent] = t.peers;
    t.offline();
    human.update(() => {
      $selectIn([0], old.indexOf('です')).insertText('X');
    });
    agent.update(() => {
      const at = old.indexOf('良');
      $selectIn([0], at, at + 1).insertText('悪');
    });
    await t.sync();
    await expectConverged(t.peers);
    expect(t.a.read(() => $getRoot().getTextContent())).toBe(
      '今日は悪い天気Xです。',
    );
  });

  // A character beyond U+FFFF is a surrogate pair, classified whole: a
  // replaced Han character there is not widened either, so a peer's format
  // on its unchanged neighbour stays (R10-B C2).
  test.each([
    ['BMP', '一丁丂', '七'],
    ['supplementary', '𠀀𠀁𠀂', '𠀃'],
  ])(
    'a replaced %s Han character ‖ bold on its neighbour',
    async (_name, old, replacement) => {
      const t = await setup(() => $getRoot().append($p(old)), {ids});
      const [, human, agent] = t.peers;
      const w = replacement.length;
      t.offline();
      human.update(() => {
        $selectIn([0], w, 2 * w).insertText(replacement);
      });
      agent.update(() => {
        $selectIn([0], 0, w).formatText('bold');
      });
      await t.sync();
      await expectConverged(t.peers);
      expect(
        t.a.read(() =>
          $getRoot()
            .getAllTextNodes()
            .map(n => [n.getTextContent(), n.getFormat()]),
        ),
      ).toEqual([
        [old.slice(0, w), 1],
        [replacement + old.slice(2 * w), 0],
      ]);
    },
  );

  // Pure inserts keep the exact diff (scope note): an insert at the start of
  // a line that begins with the same words lands whole at the start.
  test.each([['end'], ['after-first-word'], ['start']])(
    'agent insert at start ‖ human typing (%s)',
    async where => {
      const old = 'Agent decision 7177. verify_1 ';
      const insert = 'Agent decision 7178. verify_2 ';
      const t = await setup(() => $getRoot().append($p(old)), {ids});
      const [, human, agent] = t.peers;
      const pos =
        where === 'end'
          ? old.length
          : where === 'start'
            ? 0
            : old.indexOf(' ') + 1;
      t.offline();
      human.update(() => {
        $selectIn([0], pos).insertText('HUMAN ');
      });
      agent.update(() => {
        $selectIn([0], 0).insertText(insert);
      });
      await t.sync();
      await expectConverged(t.peers);
      const merged = t.a.read(() => $getRoot().getTextContent());
      // At the start, both inserts have the same place: their order follows
      // the client ids.
      expect(
        where === 'start'
          ? merged === insert + 'HUMAN ' + old ||
              merged === 'HUMAN ' + insert + old
          : merged.startsWith(insert + old.slice(0, pos)),
        merged,
      ).toBe(true);
      expect(merged).toContain('HUMAN');
    },
  );
});

describe('snapToWords', () => {
  test('a replacement that brings a child node keeps its exact diff (no letters rewritten)', () => {
    // A line's text "<14>" and an inline node, written as "<19>", a node,
    // "<20>" and the node (property seed 762): widening to the token would
    // rewrite "<1" and ">", which a peer's concurrent undo restored too.
    expect(snapToWords('<14>\ufffc', '<19>\ufffc<20>\ufffc', 2, 2)).toEqual({
      prefix: 2,
      suffix: 2,
    });
    expect(snapToWords('a\ufffcb word', 'a word', 1, 5)).toEqual({
      prefix: 1,
      suffix: 5,
    });
  });
  test('a character beyond U+FFFF is classified whole (R10-B C2)', () => {
    // Han: each character is a word, as in the Basic Multilingual Plane.
    expect(snapToWords('𠀀𠀁𠀂', '𠀀𠀃𠀂', 2, 2)).toEqual({
      prefix: 2,
      suffix: 2,
    });
    expect(snapToWords('一丁丂', '一七丂', 1, 1)).toEqual({
      prefix: 1,
      suffix: 1,
    });
    // Mathematical letters: a word, dropped whole characters at a time.
    expect(snapToWords('ab𝐀𝐁 cd', 'ab𝐀X cd', 4, 3)).toEqual({
      prefix: 0,
      suffix: 3,
    });
    expect(snapToWords('x 𝐀𝐁c', 'x Y𝐁c', 2, 3)).toEqual({
      prefix: 2,
      suffix: 0,
    });
  });
  test('a text rewrite still replaces whole words', () => {
    expect(snapToWords('the quick brown fox', 'the quxwn fox', 6, 6)).toEqual({
      prefix: 4,
      suffix: 4,
    });
  });
});
