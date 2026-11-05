/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A NodeState value stored flat (`s:<key>`, see Ident.covered) is not a
// paired run: it is written by main's format rules, which no covered key
// reaches any more. The issues' repros of those rules, with a flat NodeState
// value in place of the format, link, color or comment of the original
// (see OwnFormatItems), with garbage collection on and off and every client
// id order:
// - #9671: a format write removes the null and the restore its own earlier
//   insert left inside its range (Cursor#formatPlain, isOwnInsertFormat).
// - A range end that restates another client's opener ends it where that
//   opener's run ended (rule 3, #9622's family: formatPlain's copied ends,
//   changeEnd).
// - #9623: an undo that restores another client's value ends the copy's run
//   where the original's run ended (YBinding#closeRestoredRuns, opensRun).

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $isTextNode,
  $setSelection,
  $setState,
  createState,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $p,
  $selectIn,
  expectConverged,
  freshReader,
  setup,
} from '../../utils/harness';

const tone = createState('tone', {
  parse: v => (typeof v === 'string' ? v : ''),
});

/** Gives the text of line `line` from `start` to `end` tone `value`. */
function $tone(line: number, start: number, end: number, value: string) {
  const selection = $selectIn([line], start, end);
  for (const node of selection.extract()) {
    if ($isTextNode(node)) {
      $setState(node, tone, value);
    }
  }
  $setSelection(null);
}

/** Inserts text with no tone at `offset` of line `line`. */
function $typePlain(line: number, offset: number, text: string) {
  $selectIn([line], offset, offset).insertNodes([$createTextNode(text)]);
  $setSelection(null);
}

/** The text nodes of line `line` that end past `offset` and have a tone. */
function $tonedAfter(line: number, offset: number): string[] {
  const out: string[] = [];
  let at = 0;
  for (const n of $block([line]).getAllTextNodes()) {
    at += n.getTextContentSize();
    if (at > offset && $getState(n, tone) !== '') {
      out.push(`${n.getTextContent()}:${$getState(n, tone)}`);
    }
  }
  return out;
}

/** Each text node of line `line`, with its tone after a colon. */
const $show = (line: number) =>
  $block([line])
    .getChildren()
    .map(n => {
      const value = $isTextNode(n) ? $getState(n, tone) : '';
      return n.getTextContent() + (value === '' ? '' : `:${value}`);
    })
    .join('|');

const GC = [true, false];
const PAIRS = [
  [1, 2],
  [2, 1],
];
const TRIPLES = [
  [1, 2, 3],
  [3, 2, 1],
  [2, 3, 1],
  [1, 3, 2],
  [2, 1, 3],
  [3, 1, 2],
];

describe('a flat NodeState value keeps main format rules', () => {
  for (const gc of GC) {
    for (const ids of PAIRS) {
      // "abcdef" (tone a) "ghi" (tone x). B types an untoned "Z" inside
      // "ghi", then tones "gZ" x; A types an untoned "1" right after Z; B
      // undoes twice.
      test(`#9671: undoing text typed into a run and then toned leaves the rest of the run as it was (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
        const t = await setup(
          () => {
            const a = $createTextNode('abcdef');
            const x = $createTextNode('ghi');
            $setState(a, tone, 'a');
            $setState(x, tone, 'x');
            $getRoot().append($createParagraphNode().append(a, x));
          },
          {gc, ids},
        );
        const [a, b] = t.peers;
        b.update(() => $typePlain(0, 7, 'Z'));
        await t.sync();
        b.update(() => $tone(0, 6, 8, 'x'));
        await t.sync();
        a.update(() => $typePlain(0, 8, '1'));
        await t.sync();
        b.undo();
        await t.sync();
        expect(a.read(() => $show(0))).toBe('abcdef:a|g:x|Z1|hi:x');
        b.undo();
        await t.sync();
        await expectConverged(t.peers);
        expect(a.read(() => $show(0))).toBe('abcdef:a|g:x|1|hi:x');
        expect((await freshReader(a)).describe()).toBe(a.describe());
      });
    }
    for (const ids of TRIPLES) {
      // "ABC DEF GHI JKL MNO": B tones "I " and then "K" (two undo steps);
      // while offline, B undoes the second and C tones " J", across the gap
      // between them. Nobody toned " MNO".
      test(`a range end that restates another client's opener ends it where that opener's run ended (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
        const t = await setup(
          () => $getRoot().append($p('ABC DEF GHI JKL MNO')),
          {
            gc,
            ids,
          },
        );
        const [, b, c] = t.peers;
        b.update(() => $tone(0, 10, 12, 'b'));
        b.update(() => $tone(0, 13, 14, 'b'));
        await t.sync();
        t.offline();
        b.undo();
        c.update(() => $tone(0, 11, 13, 'c'));
        await t.sync();
        await expectConverged(t.peers);
        expect(t.a.read(() => $tonedAfter(0, 14))).toEqual([]);
        expect((await freshReader(t.a)).describe()).toBe(t.a.describe());
      });
    }
    for (const ids of PAIRS) {
      // "aaa bbb ccc": B tones "bbb" y; A types an untoned "Z" inside it;
      // B undoes. A's restore after Z restates B's run, so it gets an end
      // of A's own after B's end (rule 5): " ccc" never takes the value.
      test(`text typed without a value inside another client's run leaves the text after that run alone when that client undoes (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
        const t = await setup(() => $getRoot().append($p('aaa bbb ccc')), {
          gc,
          ids,
        });
        const [a, b] = t.peers;
        b.update(() => $tone(0, 4, 7, 'y'));
        await t.sync();
        a.update(() => $typePlain(0, 5, 'Z'));
        await t.sync();
        expect(a.read(() => $show(0))).toBe('aaa |b:y|Z|bb:y| ccc');
        b.undo();
        await t.sync();
        await expectConverged(t.peers);
        expect(a.read(() => $tonedAfter(0, 8))).toEqual([]);
        expect((await freshReader(a)).describe()).toBe(a.describe());
      });
      // "ab": A tones it y while B, offline, tones "b" y too, so an item
      // of B's gives "b" the value "a" already has. A then types an untoned
      // "Z" between them: the restore after Z is B's item, reused.
      test(`text typed without a value right before another client's item that restates it reuses that item as its restore (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
        const t = await setup(() => $getRoot().append($p('ab cd')), {gc, ids});
        const [a, b] = t.peers;
        t.offline();
        a.update(() => $tone(0, 0, 2, 'y'));
        b.update(() => $tone(0, 1, 2, 'y'));
        await t.sync();
        a.update(() => $typePlain(0, 1, 'Z'));
        await t.sync();
        await expectConverged(t.peers);
        expect(a.read(() => $show(0))).toBe('a:y|Z|b:y| cd');
        expect((await freshReader(a)).describe()).toBe(a.describe());
      });
      // "aaa bbb": A and B, offline, tone "bbb" y and z: two openers of
      // the key before its first character. A then tones "bbb" w: the
      // earlier of the two is removed, the later kept (rules 1 and 2).
      test(`a range that starts at two openers of the key keeps only the later (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
        const t = await setup(() => $getRoot().append($p('aaa bbb ccc')), {
          gc,
          ids,
        });
        const [a, b] = t.peers;
        t.offline();
        a.update(() => $tone(0, 4, 7, 'y'));
        b.update(() => $tone(0, 4, 7, 'z'));
        await t.sync();
        await expectConverged(t.peers);
        a.update(() => $tone(0, 4, 7, 'w'));
        await t.sync();
        await expectConverged(t.peers);
        expect(a.read(() => $show(0))).toBe('aaa |bbb:w| ccc');
        expect((await freshReader(a)).describe()).toBe(a.describe());
      });
      for (const removal of ['whole line', 'that word only'] as const) {
        // B tones "two t"; A removes tone (from the whole line, or from
        // that word); B undoes, then A undoes.
        test(`#9623: a value its author undid stays off the rest of the line when a collaborator undoes removing it (removal: ${removal}, gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
          const t = await setup(
            () => $getRoot().append($p('one one one'), $p('two two two')),
            {gc, ids},
          );
          const [a, b] = t.peers;
          b.update(() => $tone(1, 0, 5, 'c2'));
          await t.sync();
          a.update(() =>
            removal === 'whole line' ? $tone(1, 0, 11, '') : $tone(1, 0, 5, ''),
          );
          await t.sync();
          b.undo();
          await t.sync();
          a.undo();
          await t.sync();
          await expectConverged(t.peers);
          expect(a.read(() => $show(0))).toBe('one one one');
          expect(['two two two', 'two t:c2|wo two']).toContain(
            a.read(() => $show(1)),
          );
          expect((await freshReader(a)).describe()).toBe(a.describe());
        });
      }
    }
  }
});
