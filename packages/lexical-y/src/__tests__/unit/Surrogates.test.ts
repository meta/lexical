/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Text diffs never split a surrogate pair.
// @vitest-environment node
import type {TextNode} from 'lexical';

import {$getRoot, $setSelection} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $p,
  $selectIn,
  expectConverged,
  freshReader,
  setup,
} from '../utils/harness';

describe('surrogate pairs', () => {
  test('replace an emoji by another sharing the high surrogate (setTextContent)', async () => {
    const t = await setup(() => $getRoot().append($p('a\u{1F600}b')));
    t.a.update(() =>
      ($block([0]).getFirstChild() as TextNode).setTextContent('a\u{1F603}b'),
    );
    await t.sync();
    await expectConverged(t.peers);
    expect(t.b.read(() => $getRoot().getTextContent())).toBe('a\u{1F603}b');
  });
  test('split a line between emoji and join', async () => {
    const t = await setup(() =>
      $getRoot().append($p('\u{1F600}\u{1F601}\u{1F602}')),
    );
    t.a.update(() => $selectIn([0], 2).insertParagraph());
    await t.sync();
    t.b.update(() => $selectIn([1], 0).deleteCharacter(true));
    await t.sync();
    await expectConverged(t.peers);
    expect(t.a.read(() => $getRoot().getTextContent())).toBe(
      '\u{1F600}\u{1F601}\u{1F602}',
    );
  });
  test('join two lines whose boundary chars share a high surrogate, then edit', async () => {
    const t = await setup(() =>
      $getRoot().append($p('x\u{1F600}'), $p('\u{1F601}y')),
    );
    t.a.update(() => $selectIn([1], 0).deleteCharacter(true));
    await t.sync();
    t.a.update(() =>
      ($block([0]).getFirstChild() as TextNode).setTextContent(
        'x\u{1F600}\u{1F602}y',
      ),
    );
    await t.sync();
    await expectConverged(t.peers);
    expect(t.b.read(() => $getRoot().getTextContent())).toBe(
      'x\u{1F600}\u{1F602}y',
    );
  });
  test('type change segment with emoji', async () => {
    const t = await setup(() => $getRoot().append($p('\u{1F600}\u{1F601}')));
    t.a.update(() => {
      const tn = $block([0]).getFirstChild() as TextNode;
      const [, right] = tn.splitText(2);
      right.toggleFormat('bold');
      right.setTextContent('\u{1F602}');
    });
    await t.sync();
    await expectConverged(t.peers);
  });
});

describe('realistic emoji edits', () => {
  test('type an emoji before an emoji (insertText at offset 0)', async () => {
    const t = await setup(() => $getRoot().append($p('\u{1F600}')));
    t.a.update(() => $selectIn([0], 0).insertText('\u{1F603}'));
    await t.sync();
    await expectConverged(t.peers);
  });
  test('type an emoji between two emoji', async () => {
    const t = await setup(() => $getRoot().append($p('x\u{1F600}\u{1F601}')));
    t.a.update(() => $selectIn([0], 3).insertText('\u{1F603}'));
    await t.sync();
    await expectConverged(t.peers);
  });
  test('bold the second of two emoji (no text change)', async () => {
    const t = await setup(() => $getRoot().append($p('\u{1F600}\u{1F601}')));
    t.a.update(() => $selectIn([0], 2, 4).formatText('bold'));
    await t.sync();
    await expectConverged(t.peers);
  });
  test('delete an emoji preceded by an emoji sharing the high surrogate (backspace)', async () => {
    const t = await setup(() => $getRoot().append($p('\u{1F600}\u{1F601}z')));
    // What Backspace after the second emoji does (headless: no DOM).
    t.a.update(() => $selectIn([0], 2, 4).removeText());
    await t.sync();
    await expectConverged(t.peers, 'paragraph("\u{1F600}z")');
  });
  test('CJK supplementary chars typed one by one', async () => {
    const t = await setup(() => $getRoot().append($p('')));
    for (const ch of ['\u{20000}', '\u{20001}', '\u{20002}']) {
      t.a.update(() =>
        $getRoot().getFirstChild()!.selectStart().insertText(ch),
      );
    }
    await t.sync();
    await expectConverged(t.peers);
  });
});

// A recorded splice of one half of a pair is written as the pair replaced
// (R17B-F1): Yjs stores text as UTF-8, where a lone half reads as U+FFFD,
// so peers and fresh readers showed `A��B` while the author showed `A😁B`.
describe('recorded splices of half a surrogate pair', () => {
  const cases: [string, string, number, number, string, string][] = [
    // [name, text, offset, deleted, inserted, expected]
    ['the low half', 'A\u{1F600}B', 2, 1, '\ude01', 'A\u{1F601}B'],
    ['the high half', 'A\u{1F600}B', 1, 1, '\ud83e', 'A\u{1FA00}B'],
    [
      'a low half and the letter after',
      'A\u{1F600}B',
      2,
      2,
      '\ude02C',
      'A\u{1F602}C',
    ],
    [
      'the letter before and a high half',
      'A\u{1F600}B',
      0,
      2,
      'C\ud83e',
      'C\u{1FA00}B',
    ],
    // A ZWJ sequence (man, woman, girl): the woman's low half.
    [
      'a low half in a ZWJ sequence',
      'x\u{1F468}\u200D\u{1F469}\u200D\u{1F467}y',
      5,
      1,
      '\udc66',
      'x\u{1F468}\u200D\u{1F466}\u200D\u{1F467}y',
    ],
    [
      'a code point of a ZWJ sequence',
      'x\u{1F468}\u200D\u{1F469}\u200D\u{1F467}y',
      4,
      2,
      '\u{1F466}',
      'x\u{1F468}\u200D\u{1F466}\u200D\u{1F467}y',
    ],
  ];
  for (const [name, text, at, del, ins, expected] of cases) {
    test(name, async () => {
      const t = await setup(() => $getRoot().append($p(text)));
      t.a.update(() => {
        ($block([0]).getFirstChild() as TextNode).spliceText(at, del, ins);
        $setSelection(null);
      });
      await t.sync();
      await expectConverged(t.peers);
      const fresh = await freshReader(t.a);
      expect(t.a.read(() => $getRoot().getTextContent())).toBe(expected);
      expect(t.b.read(() => $getRoot().getTextContent())).toBe(expected);
      expect(fresh.read(() => $getRoot().getTextContent())).toBe(expected);
      fresh.stop();
    });
  }
});
