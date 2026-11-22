/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// #9636: `setTextContent` (and any text set whole without a caret) found an
// insertion or a deletion by its common start first, so where equal letters
// allowed it the edit landed inside words: `t1z t2z t3z` set to `t1z t3z`
// deleted `2z t`, and a collaborator's concurrent delete of `t2z` left
// `t1z 3z`. An insertion or a deletion of set text now goes to a word edge of
// the run of equal text it could be in, the first one (a word deleted with
// the space before it), unless the caret placed it.

import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {diffStrings, setTextEnds, snapToWords} from '../../../internal/Inline';
import {expectConverged, flush, freshReader, setup} from '../../utils/harness';

const $node = () =>
  (
    $getRoot().getFirstChildOrThrow() as ElementNode
  ).getFirstChildOrThrow() as TextNode;
const $splice = (at: number, n: number, insert: string) => () => {
  const node = $node();
  const s = $createRangeSelection();
  s.anchor.set(node.getKey(), at, 'text');
  s.focus.set(node.getKey(), at + n, 'text');
  $setSelection(s);
  if (insert === '') {
    s.removeText();
  } else {
    s.insertText(insert);
  }
  $setSelection(null);
};

const IDS = [
  [1, 2],
  [2, 1],
];

describe('#9636: a word set away with setTextContent ‖ a collaborator edits next to it', () => {
  for (const ids of IDS) {
    for (const [name, base, set, at, n, insert, expected] of [
      ['both delete t2z', 't1z t2z t3z', 't1z t3z', 4, 3, '', 't1z t3z'],
      [
        'the peer types " q9z" after t2z',
        't1z t2z t3z',
        't1z t3z',
        7,
        0,
        ' q9z',
        't1z q9z t3z',
      ],
      [
        'both delete t3z of four',
        't1z t2z t3z t4z',
        't1z t2z t4z',
        8,
        3,
        '',
        't1z t2z t4z',
      ],
      [
        'set adds t2z ‖ the peer deletes t1z',
        't1z t3z',
        't1z t2z t3z',
        0,
        3,
        '',
        ' t2z t3z',
      ],
    ] as [string, string, string, number, number, string, string][]) {
      for (const timing of ['concurrent', 'unread'] as const) {
        test(`${name}, ${timing} (ids ${ids})`, async () => {
          const t = await setup(
            () => {
              $getRoot().append(
                $createParagraphNode().append($createTextNode(base)),
              );
            },
            {ids},
          );
          t.offline();
          const $set = () => {
            $node().setTextContent(set);
            $setSelection(null);
          };
          if (timing === 'unread') {
            t.b.update($splice(at, n, insert));
            t.a.editor.update($set);
            await t.sync();
            await flush();
            await t.sync();
          } else {
            t.a.update($set);
            t.b.update($splice(at, n, insert));
            await t.sync();
          }
          const fresh = await freshReader(t.a);
          const texts = [...t.peers, fresh].map(p =>
            p.read(() => $getRoot().getTextContent()),
          );
          expect(texts).toEqual(texts.map(() => expected));
          await expectConverged(t.peers);
        });
      }
    }
  }
});

// A caret that places the edit keeps placing it (the text after it is
// unchanged), wherever it is in the run of equal text, the rightmost place
// included: typing a space after two spaces keeps the old two together.
describe('#9636: a caret keeps placing the edit', () => {
  for (const [a, b, cursor] of [
    ['a  b', 'a   b', 4],
    ['aaa', 'aaaa', 4],
    ['😀😀', '😀😀😀', 6],
    ['哈哈', '哈哈哈', 3],
    ['a...b', 'a....b', 5],
    ['t1z t2z t3z', 't1z t3z', 4],
  ] as [string, string, number][]) {
    test(`${JSON.stringify(a)} set to ${JSON.stringify(b)} with the caret at ${cursor}`, () => {
      const diff = diffStrings(a, b, cursor);
      expect(setTextEnds(a, b, cursor, false)).toEqual(
        snapToWords(a, b, diff.prefix, diff.suffix, false),
      );
    });
  }
  for (const ids of IDS) {
    for (const record of [true, false]) {
      test(`a space typed after two spaces ‖ the peer types between them, ${record ? 'recorded' : 'diffed by the writer'} (ids ${ids})`, async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('a  b')),
            );
          },
          {ids},
        );
        const recording = t.a.editor._recordTextEdits;
        try {
          t.a.editor._recordTextEdits = record;
          t.a.editor.update(() => $node().select(3, 3), {discrete: true});
          t.offline();
          t.a.update(() => {
            $node().setTextContent('a   b');
            $node().select(4, 4);
          });
          t.b.update(() => {
            $node().spliceText(2, 0, 'Q', false);
            $setSelection(null);
          });
          await t.sync();
          const fresh = await freshReader(t.a);
          expect(
            [...t.peers, fresh].map(p =>
              p.read(() => $getRoot().getTextContent()),
            ),
          ).toEqual(['a Q  b', 'a Q  b', 'a Q  b']);
          await expectConverged(t.peers);
        } finally {
          t.a.editor._recordTextEdits = recording;
        }
      });
    }
    // An edit and a set in one update are composed without a caret: a
    // space added to two spaces stays where the diff puts it, at word
    // edges already.
    test(`a letter typed, then the text set with a space added to two spaces ‖ the peer types between them (ids ${ids})`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('a  b')),
          );
        },
        {ids},
      );
      t.offline();
      t.a.update(() => {
        $node().spliceText(0, 0, 'X', false);
        $node().setTextContent('Xa   b');
        $setSelection(null);
      });
      t.b.update(() => {
        $node().spliceText(2, 0, 'Q', false);
        $setSelection(null);
      });
      await t.sync();
      const fresh = await freshReader(t.a);
      expect(
        [...t.peers, fresh].map(p => p.read(() => $getRoot().getTextContent())),
      ).toEqual(['Xa Q  b', 'Xa Q  b', 'Xa Q  b']);
      await expectConverged(t.peers);
    });
  }
});

// A caret at the end of the node, or anywhere past the edit, anchors every
// place of the run of equal text, so it places nothing: `setTextContent`
// followed by `selectEnd()` (what code that sets a node's text usually does)
// is placed as without a caret, and so is a set with the caret in a later
// node, for which the writer anchors the diff at the end of the node.
describe('#9636: a caret past the edit', () => {
  test('places nothing: `t1z t2z t3z` set to `t1z t3z` with the caret at the end', () => {
    expect(setTextEnds('t1z t2z t3z', 't1z t3z', 7, false)).toEqual({
      prefix: 3,
      suffix: 4,
    });
  });
  // A caret in the run, the furthest place included, still places it.
  for (const [a, b, cursor, want] of [
    ['t1z t2z t3z', 't1z t3z', 5, {prefix: 5, suffix: 2}],
    ['ab ab', 'ab abz ab', 9, {prefix: 5, suffix: 0}],
  ] as const) {
    test(`a caret in the run places it: ${JSON.stringify(a)} set to ${JSON.stringify(b)} with the caret at ${cursor}`, () => {
      expect(setTextEnds(a, b, cursor, false)).toEqual(want);
    });
  }
  for (const ids of IDS) {
    for (const record of [true, false]) {
      const how = record ? 'recorded' : 'diffed by the writer';
      // Typed right before `t2z`, the peer's word is glued to the word
      // before it, as y.md documents for a set without a caret (it was
      // `t1z q9z t3z` while a caret at the end pinned the diff).
      for (const [peer, splice, want] of [
        ['deletes t2z', [4, 3, ''], 't1z t3z'],
        ['types " q9z" after t2z', [7, 0, ' q9z'], 't1z q9z t3z'],
        ['types "q9z " before t2z', [4, 0, 'q9z '], 't1zq9z  t3z'],
      ] as const) {
        for (const caret of ['at the end', 'in the next node'] as const) {
          test(`set with the caret ${caret} ‖ the peer ${peer}, ${how} (ids ${ids})`, async () => {
            const t = await setup(
              () => {
                const line = $createParagraphNode().append(
                  $createTextNode('t1z t2z t3z'),
                );
                if (caret === 'in the next node') {
                  line.append($createTextNode('!').toggleFormat('bold'));
                }
                $getRoot().append(line);
              },
              {ids},
            );
            const recording = t.a.editor._recordTextEdits;
            try {
              t.a.editor._recordTextEdits = record;
              t.offline();
              t.a.update(() => {
                $node().setTextContent('t1z t3z');
                if (caret === 'at the end') {
                  $node().selectEnd();
                } else {
                  ($node().getNextSibling() as TextNode).select(1, 1);
                }
              });
              t.b.update($splice(splice[0], splice[1], splice[2]));
              await t.sync();
              const end = caret === 'in the next node' ? '!' : '';
              const fresh = await freshReader(t.a);
              expect(
                [...t.peers, fresh].map(p =>
                  p.read(() => $getRoot().getTextContent()),
                ),
              ).toEqual([want + end, want + end, want + end]);
              await expectConverged(t.peers);
            } finally {
              t.a.editor._recordTextEdits = recording;
            }
          });
        }
      }
    }
    test(`\`1..\` set to \`1.\` with the caret at 2 ‖ the peer types between the dots (ids ${ids})`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('1..')),
          );
        },
        {ids},
      );
      t.a.editor.update(() => $node().select(3, 3), {discrete: true});
      t.offline();
      t.a.update(() => {
        $node().setTextContent('1.');
        $node().select(2, 2);
      });
      t.b.update($splice(2, 0, 'x'));
      await t.sync();
      expect(
        t.peers.map(p => p.read(() => $getRoot().getTextContent())),
      ).toEqual(['1.x', '1.x']);
      await expectConverged(t.peers);
    });
  }
});

// A word set away next to a word that ends or starts like it: the edit is
// not moved onto a piece of a word that stays (`a ba c` set to `a c`
// deletes ` ba`, not `a b`, which would keep the `a` of `ba` as the first
// word, so a collaborator's concurrent delete of `ba` took the first `a`).
describe('#9636: a word set away next to a word with the same ending', () => {
  for (const ids of IDS) {
    for (const [base, set, del, want] of [
      ['a ba c', 'a c', 'ba', ['a', 'c']],
      ['one someone end', 'one end', 'someone', ['one', 'end']],
      ['x ax ab', 'x ab', 'ax', ['x', 'ab']],
      ['a c', 'a ba c', 'a', ['ba', 'c']],
      ['one end', 'one someone end', 'one', ['someone', 'end']],
    ] as [string, string, string, string[]][]) {
      test(`"${base}" set to "${set}" ‖ the peer deletes "${del}" (ids ${ids})`, async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode(base)),
            );
          },
          {ids},
        );
        t.offline();
        t.a.update(() => {
          $node().setTextContent(set);
          $setSelection(null);
        });
        const at = (' ' + base + ' ').indexOf(' ' + del + ' ');
        t.b.update($splice(at, del.length, ''));
        await t.sync();
        const fresh = await freshReader(t.a);
        const texts = [...t.peers, fresh].map(p =>
          p.read(() => $getRoot().getTextContent()),
        );
        const words = texts[0].split(/ +/).filter(Boolean);
        expect(new Set(texts).size).toBe(1);
        expect(words).toEqual(want);
        await expectConverged(t.peers);
      });
    }
  }
});

/** A seeded random integer below `n`. */
function random(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return n => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), s | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return Math.floor((((x ^ (x >>> 14)) >>> 0) / 4294967296) * n);
  };
}

const SEEDS = Number(process.env.LEXICAL_Y_SEEDS || 150);

// The property: a line of words that share letters (`t<n>z`, one or two
// digits) is set with setTextContent to the line with one word deleted or
// inserted, while a collaborator deletes a word, or types a word after a
// word (a space, then the word) or before one (the word, then a space),
// concurrently or before the setter read it, in either client id order.
// Every word of the result is a whole word (no word split or glued to
// another), a word either of them deleted stays deleted, a word either of
// them added is there once, and every client and a fresh reader agree. One
// exception, counted apart and documented (y.md, Limits): a word typed right
// against a word the set deletes, on the side of the space the set deletes
// with it, is glued to the word beyond (`t1z t2z t3z` set to `t1z t3z`
// deletes ` t2z`, and a word typed before `t2z` joins `t1z`; a line's first
// word has no space before it, so its space after it goes).
describe('#9636: set text and a collaborator edit keep every word whole', () => {
  for (const timing of ['concurrent', 'unread'] as const) {
    for (const edit of ['delete', 'type after', 'type before'] as const) {
      test(`${timing}: one word deleted or inserted by setTextContent ‖ the peer ${edit}s a word`, async () => {
        const failures: string[] = [];
        let gluedCount = 0;
        for (let seed = 1; seed <= SEEDS; seed++) {
          const rnd = random(
            seed * 104729 + (timing === 'unread' ? 7 : 0) + edit.length,
          );
          const count = 3 + rnd(5);
          const numbers = new Set<number>();
          while (numbers.size < count + 2) {
            numbers.add(1 + rnd(30));
          }
          const [made, typed, ...words] = [...numbers].map(x => `t${x}z`);
          const old = words.join(' ');
          const target = rnd(words.length);
          const insertSet = rnd(2) === 0;
          const next = insertSet
            ? [...words.slice(0, target), made, ...words.slice(target)]
            : words.filter((_, i) => i !== target);
          // The peer's word: any old word (for a delete, one the set keeps).
          const choices = words.filter(
            (w, i) => edit !== 'delete' || insertSet || i !== target,
          );
          const victim = choices[rnd(choices.length)];
          const vAt =
            old.split(' ').slice(0, words.indexOf(victim)).join(' ').length +
            (words.indexOf(victim) > 0 ? 1 : 0);
          const ids = rnd(2) === 0 ? [1, 2] : [2, 1];
          const t = await setup(
            () => {
              $getRoot().append(
                $createParagraphNode().append($createTextNode(old)),
              );
            },
            {ids},
          );
          t.offline();
          const $set = () => {
            $node().setTextContent(next.join(' '));
            $setSelection(null);
          };
          const $peer =
            edit === 'delete'
              ? $splice(vAt, victim.length, '')
              : edit === 'type after'
                ? $splice(vAt + victim.length, 0, ` ${typed}`)
                : $splice(vAt, 0, `${typed} `);
          if (timing === 'unread') {
            t.b.update($peer);
            t.a.editor.update($set);
            await t.sync();
            await flush();
            await t.sync();
          } else {
            t.a.update($set);
            t.b.update($peer);
            await t.sync();
          }
          const fresh = await freshReader(t.a);
          const texts = [...t.peers, fresh].map(p =>
            p.read(() => $getRoot().getTextContent()),
          );
          const got = texts[0].split(/ +/).filter(Boolean);
          const problems: string[] = [];
          if (new Set(texts).size > 1) {
            problems.push(`diverged ${JSON.stringify(texts)}`);
          }
          // A word typed against the deleted word, glued to its neighbour
          // on the side y.md documents: typed before it, to the word before
          // it; typed after a line's first word, to the word after it.
          const gone = insertSet || victim !== words[target] ? -1 : target;
          const glued = (w: string) =>
            gone >= 0 &&
            (edit === 'type before'
              ? gone > 0 && w === words[gone - 1] + typed
              : edit === 'type after' && gone === 0 && w === typed + words[1]);
          for (const w of got.filter(glued)) {
            got.splice(
              got.indexOf(w),
              1,
              ...(w.startsWith(typed)
                ? [typed, w.slice(typed.length)]
                : [w.slice(0, -typed.length), typed]),
            );
            gluedCount++;
          }
          for (const w of got) {
            if (!/^t\d+z$/.test(w)) {
              problems.push(`"${w}" not a word`);
            }
          }
          const want = new Set(next);
          if (edit === 'delete') {
            want.delete(victim);
          } else {
            want.add(typed);
          }
          for (const w of want) {
            if (got.filter(x => x === w).length !== 1) {
              problems.push(`"${w}" x${got.filter(x => x === w).length}`);
            }
          }
          for (const w of got) {
            if (!want.has(w)) {
              problems.push(`"${w}" came back`);
            }
          }
          if (problems.length > 0) {
            failures.push(
              `seed ${seed} ids ${ids} "${old}" -> "${next.join(' ')}"; ${edit} "${victim}": ${JSON.stringify(texts[0])}: ${problems.join(', ')}`,
            );
          }
        }
        expect(failures).toEqual([]);
        if (process.env.LEXICAL_Y_VERBOSE) {
          // eslint-disable-next-line no-console
          console.log(`glued ${gluedCount} of ${SEEDS}`);
        }
      }, 120_000);
    }
  }
});
