/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// #9621: a line's text nodes made again with two or more words changed (an
// agent rewriting a block from its JSON) kept only the common start and end
// of the line's text (#9598) and wrote everything between the first and the
// last changed word again. A word a collaborator deleted there at the same
// time came back, and when the collaborator undid its delete the word showed
// twice. Every unchanged stretch of whole words between the changes now
// keeps its characters, so only the changed words are written.

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  $parseSerializedNode,
  $setSelection,
  type ElementNode,
  type SerializedTextNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {keptStretches} from '../../../internal/Inline';
import {
  expectConverged,
  flush,
  freshReader,
  type Peer,
  setup,
} from '../../utils/harness';

const $line = () => $getRoot().getChildAtIndex(1) as ElementNode;
const lineText = (p: Peer) => p.read(() => $line().getTextContent());

/** The line's text nodes made again from their JSON, with `changes`. */
const $remake = (changes: [string, string][]) => () => {
  const olds = $line().getChildren().filter($isTextNode) as TextNode[];
  const made = olds.map(o => {
    const json = o.exportJSON() as SerializedTextNode;
    let text = json.text;
    for (const [from, to] of changes) {
      text = text.replace(from, to);
    }
    return $parseSerializedNode({...json, text});
  });
  for (const o of olds) {
    o.remove();
  }
  $line().append(...made);
  $setSelection(null);
};

/**
 * `n` characters of the line from character `at` spliced with `insert`,
 * whatever text nodes hold them.
 */
const $splice =
  (at: number, n: number, insert = '') =>
  () => {
    let acc = 0;
    const spans: [TextNode, number, number][] = [];
    for (const leaf of $line().getAllTextNodes()) {
      const size = leaf.getTextContentSize();
      const s0 = Math.max(at, acc);
      const s1 = Math.min(at + n, acc + size);
      if (s1 > s0 || (n === 0 && at >= acc && at <= acc + size)) {
        spans.push([leaf, s0 - acc, Math.max(0, s1 - s0)]);
        if (n === 0) {
          break;
        }
      }
      acc += size;
    }
    spans.reverse().forEach(([leaf, offset, count], i) => {
      leaf.spliceText(
        offset,
        count,
        i === spans.length - 1 ? insert : '',
        false,
      );
    });
    $setSelection(null);
  };

const IDS = [
  [1, 2],
  [2, 1],
];

const LINE = 't1z t2z t3z t4z t5z t6z t7z';

describe('#9621: a delete between two words a remade line changes stays deleted', () => {
  for (const ids of IDS) {
    for (const [name, changes, expected] of [
      [
        'two changes around it',
        [
          ['t2z', 'n9z'],
          ['t7z', 'n8z'],
        ],
        't1z n9z t3z t4z  t6z n8z',
      ],
      [
        'three changes, one on each side and one next to it',
        [
          ['t1z', 'n7z'],
          ['t4z', 'n9z'],
          ['t7z', 'n8z'],
        ],
        'n7z t2z t3z n9z  t6z n8z',
      ],
    ] as [string, [string, string][], string][]) {
      for (const timing of ['concurrent', 'unread'] as const) {
        test(`${name}: B deletes "t5z", ${timing} (ids ${ids})`, async () => {
          const t = await setup(
            () => {
              $getRoot().append(
                $createParagraphNode().append($createTextNode('Title')),
                $createParagraphNode().append($createTextNode(LINE)),
              );
            },
            {ids},
          );
          t.offline();
          if (timing === 'unread') {
            t.b.update($splice(16, 3));
            t.a.editor.update($remake(changes));
            await t.sync();
            await flush();
            await t.sync();
          } else {
            t.b.update($splice(16, 3));
            t.a.update($remake(changes));
            await t.sync();
          }
          const fresh = await freshReader(t.a);
          expect([...t.peers, fresh].map(lineText)).toEqual(
            [...t.peers, fresh].map(() => expected),
          );
          await expectConverged(t.peers);
          expect(t.peers.flatMap(p => p.warnings)).toEqual([]);
        });
      }

      for (const live of [false, true]) {
        test(`${name}: B deletes "t5z" and undoes ${live ? 'after reading the remake' : 'concurrently'} (ids ${ids})`, async () => {
          const t = await setup(
            () => {
              $getRoot().append(
                $createParagraphNode().append($createTextNode('Title')),
                $createParagraphNode().append($createTextNode(LINE)),
              );
            },
            {ids},
          );
          t.offline();
          t.b.update($splice(16, 3));
          t.a.update($remake(changes));
          if (live) {
            await t.sync();
          }
          t.b.undo();
          await t.sync();
          const want = expected.replace('  ', ' t5z ');
          const fresh = await freshReader(t.a);
          expect([...t.peers, fresh].map(lineText)).toEqual(
            [...t.peers, fresh].map(() => want),
          );
          await expectConverged(t.peers);
          expect(t.peers.flatMap(p => p.warnings)).toEqual([]);
        });
      }
    }
  }
});

// Words of other shapes between the two changes: each character of a script
// written without spaces is a word of its own, an emoji is part of a word,
// and two runs of unchanged words with other white space between them stay
// two runs.
describe('#9621: unchanged words of other shapes between two changes keep a delete', () => {
  for (const ids of IDS) {
    for (const [name, line, changes, del, expected] of [
      [
        'a script written without spaces',
        '今日は晴れです明日は雨です',
        [
          ['今', '昨'],
          ['雨です', '雪でした'],
        ],
        '晴れ',
        '昨日はです明日は雪でした',
      ],
      [
        'emoji',
        '😀a t1z 😁 t2z 😂b',
        [
          ['😀a', '🙂a'],
          ['😂b', '🙃b'],
        ],
        't1z',
        '🙂a  😁 t2z 🙃b',
      ],
      [
        'runs with other white space between them',
        't1z t2z  t3z\tt4z t5z',
        [
          ['t1z', 'n1z'],
          ['t5z', 'n5z'],
          ['  ', ' '],
        ],
        't3z',
        'n1z t2z \tt4z n5z',
      ],
    ] as [string, string, [string, string][], string, string][]) {
      test(`${name}: B deletes "${del}" (ids ${ids})`, async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('Title')),
              $createParagraphNode().append($createTextNode(line)),
            );
          },
          {ids},
        );
        const before = lineText(t.a);
        t.offline();
        t.b.update($splice(before.indexOf(del), del.length));
        t.a.update($remake(changes));
        await t.sync();
        const fresh = await freshReader(t.a);
        expect([...t.peers, fresh].map(lineText)).toEqual(
          [...t.peers, fresh].map(() => expected),
        );
        await expectConverged(t.peers);
        expect(t.peers.flatMap(p => p.warnings)).toEqual([]);
      });
    }
  }
});

// A word changed in part is written whole (an insertion between two of its
// letters, #9598), so a collaborator's delete of its unchanged part, undone,
// comes back next to the new word: #9635, as two clients removing the same
// text and both undoing (D50). Separate words keep theirs.
describe('#9635: an undone delete of part of a word changed in part', () => {
  for (const ids of IDS) {
    for (const [name, line, made, glued] of [
      ['glued word', 'aa bbcc dd', 'aa bb xxcc dd', true],
      ['separate words', 'aa bb cc dd', 'aa bb xx cc dd', false],
    ] as [string, string, string, boolean][]) {
      (glued ? test.fails : test)(
        `${name}: "${line}" made again as "${made}" ‖ the peer deletes "aa bb" and undoes (ids ${ids})${glued ? ': bb shows twice (#9635)' : ''}`,
        async () => {
          const t = await setup(
            () => {
              $getRoot().append(
                $createParagraphNode().append($createTextNode('Title')),
                $createParagraphNode().append($createTextNode(line)),
              );
            },
            {ids},
          );
          t.offline();
          t.a.update($remake([[line.slice(3), made.slice(3)]]));
          t.b.update($splice(0, 5));
          t.b.undo();
          await t.sync();
          const fresh = await freshReader(t.a);
          expect([...t.peers, fresh].map(lineText)).toEqual(
            [...t.peers, fresh].map(() => made),
          );
          await expectConverged(t.peers);
        },
      );
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

/** `text` cut into 1 to `most` pieces at random places. */
function cuts(rnd: (n: number) => number, text: string, most: number) {
  const at = new Set<number>();
  const count = rnd(most);
  for (let i = 0; i < count && text.length > 1; i++) {
    at.add(1 + rnd(text.length - 1));
  }
  const out: string[] = [];
  let prev = 0;
  for (const c of [...[...at].sort((x, y) => x - y), text.length]) {
    out.push(text.slice(prev, c));
    prev = c;
  }
  return out;
}

const SEEDS = Number(process.env.LEXICAL_Y_SEEDS || 120);

type Edit = 'delete' | 'type' | 'delete, undo' | 'type, undo' | 'bold';
const EDITS: readonly Edit[] = [
  'delete',
  'type',
  'delete, undo',
  'type, undo',
  'bold',
];

// The property: a line of unique words (one or two spaces or ", " between
// them) in 1 to 4 text nodes, some bold or italic, is made again as 1 to 3
// plain nodes with 2 to 4 word edits (words replaced, inserted or deleted
// anywhere), while a collaborator edits a word no edit changes: deletes some
// of its characters, types a letter into it, either of them and then undoes
// it, or bolds it; as a concurrent edit or one the writer has not read yet,
// in both client id orders. Every client and a fresh reader agree, every
// word shows at most once, every word the rewrite made is whole, the
// collaborator's edit is where it was made (a delete stays deleted, an undone
// edit leaves the word as it was), and nothing warns.
describe('#9621: nothing a collaborator deleted comes back, nothing shows twice', () => {
  for (const timing of ['unread', 'concurrent'] as const) {
    for (const edit of EDITS) {
      test(`${timing}: random lines made again with 2 to 4 word edits ‖ the peer ${edit}s an unchanged word`, async () => {
        const failures: string[] = [];
        for (let seed = 1; seed <= SEEDS; seed++) {
          const rnd = random(
            seed * 7919 +
              EDITS.indexOf(edit) * 131 +
              (timing === 'unread' ? 17 : 0),
          );
          const count = 4 + rnd(8);
          const numbers = new Set<number>();
          while (numbers.size < count + 4) {
            numbers.add(100 + rnd(900));
          }
          // Three digits each, so a delete of digits never makes another
          // word; some words end in punctuation, each keeps the separator
          // before it.
          const pool = [...numbers].map(
            n => `t${n}z${['', '', '', ',', '.'][rnd(5)]}`,
          );
          const words = pool.slice(0, count);
          const fresh = pool.slice(count);
          const sep = new Map(pool.map(w => [w, [' ', ' ', '  '][rnd(3)]]));
          const join = (ws: string[]) =>
            ws.map((w, i) => (i === 0 ? w : sep.get(w) + w)).join('');
          const old = join(words);
          let next = [...words];
          const edits = 2 + rnd(3);
          for (let e = 0; e < edits; e++) {
            const kind = rnd(3);
            const at = rnd(next.length);
            if (kind === 0 || next.length < 3) {
              next[at] = fresh[e];
            } else if (kind === 1) {
              next.splice(at, 0, fresh[e]);
            } else {
              next.splice(at, 1);
            }
          }
          next = next.filter(Boolean);
          const unchanged = words.filter(w => next.includes(w));
          if (unchanged.length === 0) {
            continue;
          }
          const made = join(next);
          const victim = unchanged[rnd(unchanged.length)];
          const vAt = old.indexOf(victim);
          const from = 1 + rnd(3);
          const len = 1 + rnd(4 - from);
          const oldPieces = cuts(rnd, old, 4);
          const formats = oldPieces.map(() => rnd(3));
          const ids = rnd(2) === 0 ? [1, 2] : [2, 1];
          const t = await setup(
            () => {
              $getRoot().append(
                $createParagraphNode().append($createTextNode('Title')),
                $createParagraphNode().append(
                  ...oldPieces.map((text, i) => {
                    const n = $createTextNode(text);
                    return formats[i] === 1
                      ? n.toggleFormat('bold')
                      : formats[i] === 2
                        ? n.toggleFormat('italic')
                        : n;
                  }),
                ),
              );
            },
            {ids},
          );
          const $remakeAll = () => {
            const olds = $line().getChildren();
            for (const o of olds) {
              o.remove();
            }
            $line().append(
              ...cuts(rnd, made, 3).map(text => $createTextNode(text)),
            );
            $setSelection(null);
          };
          const $peer = edit.startsWith('delete')
            ? $splice(vAt + from, len)
            : $splice(vAt + from, 0, 'Q');
          const $bold = () => {
            // Bold the victim: split its text out and toggle the format.
            let acc = 0;
            for (const leaf of $line().getAllTextNodes()) {
              const size = leaf.getTextContentSize();
              const s0 = Math.max(vAt, acc);
              const s1 = Math.min(vAt + victim.length, acc + size);
              if (s1 > s0) {
                const parts = leaf.splitText(s0 - acc, s1 - acc);
                const mid = s0 - acc === 0 ? parts[0] : parts[1];
                if (!mid.hasFormat('bold')) {
                  mid.toggleFormat('bold');
                }
              }
              acc += size;
            }
            $setSelection(null);
          };
          const $edit = edit === 'bold' ? $bold : $peer;
          t.offline();
          if (timing === 'unread') {
            t.b.update($edit);
            t.a.editor.update($remakeAll);
            await t.sync();
            await flush();
            await t.sync();
          } else {
            t.a.update($remakeAll);
            t.b.update($edit);
            await t.sync();
          }
          if (edit.endsWith('undo')) {
            t.b.undo();
            await t.sync();
          }
          const reader = await freshReader(t.a);
          const texts = [...t.peers, reader].map(lineText);
          const got = texts[0].split(/ +/).filter(Boolean);
          const problems: string[] = [];
          if (new Set(texts).size > 1) {
            problems.push(`diverged ${JSON.stringify(texts)}`);
          }
          const dups = got.filter((w, i) => got.indexOf(w) !== i);
          if (dups.length > 0) {
            problems.push(`twice: ${dups.join(' ')}`);
          }
          const edited =
            edit === 'delete'
              ? victim.slice(0, from) + victim.slice(from + len)
              : edit === 'type'
                ? victim.slice(0, from) + 'Q' + victim.slice(from)
                : victim;
          if (!got.includes(edited)) {
            problems.push(`"${edited}" missing`);
          }
          if (edited !== victim && got.includes(victim)) {
            problems.push(`"${victim}" came back`);
          }
          for (const w of next) {
            if (w !== victim && !got.includes(w)) {
              problems.push(`"${w}" not whole`);
            }
          }
          // The rewrite makes plain text: a bold it keeps is the peer's,
          // on a word that was plain (the rewrite did not change its
          // format).
          let acc = 0;
          const wasPlain = oldPieces.every((piece, i) => {
            const s0 = acc;
            acc += piece.length;
            return formats[i] === 0 || acc <= vAt || s0 >= vAt + victim.length;
          });
          if (edit === 'bold' && wasPlain) {
            const bold = t.a.read(() =>
              $line()
                .getAllTextNodes()
                .filter(n => n.hasFormat('bold'))
                .map(n => n.getTextContent())
                .join(''),
            );
            if (!bold.includes(victim)) {
              problems.push(
                `"${victim}" not bold (bold: ${JSON.stringify(bold)})`,
              );
            }
          }
          const warnings = [...t.peers, reader].flatMap(p => p.warnings);
          if (warnings.length > 0) {
            problems.push(`warnings ${warnings.join('; ')}`);
          }
          if (problems.length > 0) {
            failures.push(
              `seed ${seed} ids ${ids} ${JSON.stringify(oldPieces)} -> ${JSON.stringify(made)}; ${edit} "${victim}" at ${from}+${len}: ${JSON.stringify(texts[0])}: ${problems.join(', ')}`,
            );
          }
        }
        expect(failures).toEqual([]);
      }, 240_000);
    }
  }
});

// Many changed words (64 to 200 replaced, each a delete and an insert), in
// lines of distinct words and of repeated ones, an earlier occurrence of a
// repeated word removed included: the exact diff keeps every unchanged word,
// so a collaborator's concurrent edit of one is kept.
describe('#9621: an edit between many changed words', () => {
  const LINES: [
    string,
    (n: number) => [string[], string[], number, number?],
  ][] = [
    [
      'distinct words',
      n => {
        const words = Array.from({length: 2 * n + 1}, (_, i) => `w${i}z`);
        return [
          words,
          words.map((w, i) => (i % 2 === 0 && i < 2 * n ? `r${i}z` : w)),
          3,
        ];
      },
    ],
    [
      'a word repeated between them',
      n => [
        [
          's1z',
          ...Array.from({length: n}, () => ['o1z', 'echo']).flat(),
          'e1z',
        ],
        [
          's2z',
          ...Array.from({length: n}, () => ['n1z', 'echo']).flat(),
          'e2z',
        ],
        4,
      ],
    ],
    [
      'repeated words, an earlier occurrence of one removed',
      n => {
        const oldWords = [
          's1z',
          ...Array.from({length: n}, () => ['o1z', 'aa', 'bb']).flat(),
          'e1z',
        ];
        const newWords = oldWords.map(w =>
          w === 'o1z' ? 'n1z' : w === 's1z' ? 's2z' : w === 'e1z' ? 'e2z' : w,
        );
        newWords.splice(2, 1);
        return [oldWords, newWords, 3, 2];
      },
    ],
    [
      'a word repeated between them and one unique word',
      n => {
        const gapA = Array.from({length: n}, () => ['o1z', 'echo']).flat();
        const gapB = Array.from({length: n}, () => ['n1z', 'echo']).flat();
        return [
          ['s1z', ...gapA, 'pin', ...gapA, 'e1z'],
          ['s2z', ...gapB, 'pin', ...gapB, 'e2z'],
          4,
        ];
      },
    ],
  ];
  for (const [shape, make] of LINES) {
    for (const changes of [64, 65, 200]) {
      for (const ids of IDS) {
        for (const edit of [
          'delete',
          'delete, undo',
          'type',
          'bold',
        ] as const) {
          test(`${shape}, ${changes} replaced ‖ the peer ${edit}s an unchanged word (ids ${ids})`, async () => {
            const [oldWords, newWords, v, newV = v] = make(changes);
            const old = oldWords.join(' ');
            const next = newWords.join(' ');
            const victim = oldWords[v];
            const at = oldWords.slice(0, v).join(' ').length + 1;
            const nextAt = newWords.slice(0, newV).join(' ').length + 1;
            const t = await setup(
              () => {
                $getRoot().append(
                  $createParagraphNode().append($createTextNode('Title')),
                  $createParagraphNode().append($createTextNode(old)),
                );
              },
              {ids},
            );
            t.offline();
            if (edit === 'bold') {
              t.b.update(() => {
                const leaf = $line().getFirstChildOrThrow() as TextNode;
                const [, mid] = leaf.splitText(at, at + victim.length);
                mid.toggleFormat('bold');
                $setSelection(null);
              });
            } else if (edit === 'type') {
              t.b.update($splice(at + 1, 0, 'Q'));
            } else {
              t.b.update($splice(at, victim.length));
            }
            t.a.update(() => {
              for (const child of $line().getChildren()) {
                child.remove();
              }
              $line().append($createTextNode(next));
              $setSelection(null);
            });
            await t.sync();
            if (edit === 'delete, undo') {
              t.b.undo();
              await t.sync();
            }
            const expected =
              edit === 'delete'
                ? next.slice(0, nextAt) + next.slice(nextAt + victim.length)
                : edit === 'type'
                  ? next.slice(0, nextAt + 1) + 'Q' + next.slice(nextAt + 1)
                  : next;
            const fresh = await freshReader(t.a);
            expect([...t.peers, fresh].map(lineText)).toEqual(
              [...t.peers, fresh].map(() => expected),
            );
            if (edit === 'bold') {
              expect(
                t.a.read(() =>
                  $line()
                    .getAllTextNodes()
                    .filter(n => n.hasFormat('bold'))
                    .map(n => n.getTextContent()),
                ),
              ).toEqual([victim]);
            }
            await expectConverged(t.peers);
            expect(t.peers.flatMap(p => p.warnings)).toEqual([]);
          });
        }
      }
    }
  }
});

// The diff of a remade line stays linear in the line's length: two changes
// at its ends (the whole line between them diffed), a change every fourth
// word, a word repeated between every two changed words, every word moved
// (past the exact diff's bound, where only the start and end are kept), and
// the white space between every two words changed in a line of one
// alternately formatted node per word (a kept run per word, a node per run).
describe('#9621: a long remade line stays linear', () => {
  const timed = async (
    n: number,
    oldNodes: (words: string[]) => TextNode[],
    newNodes: (words: string[]) => TextNode[],
    expected: (words: string[]) => string,
  ) => {
    const words = Array.from({length: n}, (_, i) => `t${i}z`);
    const t = await setup(() => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('Title')),
        $createParagraphNode().append(...oldNodes(words)),
      );
    });
    const start = performance.now();
    t.a.update(() => {
      for (const child of $line().getChildren()) {
        child.remove();
      }
      $line().append(...newNodes(words));
      $setSelection(null);
    });
    const ms = performance.now() - start;
    expect(lineText(t.a)).toBe(expected(words));
    await t.sync();
    expect(lineText(t.b)).toBe(expected(words));
    return ms;
  };
  const changed = (every: number) => (words: string[]) =>
    words
      .map((w, i) => (i % every === 0 || i === words.length - 1 ? `n${i}z` : w))
      .join(' ');
  const perWord = (sep: string) => (words: string[]) =>
    words.map((w, i) => {
      const node = $createTextNode(w + (i === words.length - 1 ? '' : sep));
      return i % 2 === 1 ? node.toggleFormat('bold') : node;
    });
  for (const [name, oldNodes, newNodes, expected] of [
    [
      'changes at both ends',
      (words: string[]) => [$createTextNode(words.join(' '))],
      (words: string[]) => [$createTextNode(changed(Infinity)(words))],
      changed(Infinity),
    ],
    [
      'a change every fourth word',
      (words: string[]) => [$createTextNode(words.join(' '))],
      (words: string[]) => [$createTextNode(changed(4)(words))],
      changed(4),
    ],
    [
      'a word repeated between every two changed words',
      (words: string[]) => [
        $createTextNode(
          words.map((_, i) => (i % 2 ? 'echo' : 'o1z')).join(' '),
        ),
      ],
      (words: string[]) => [
        $createTextNode(
          words.map((_, i) => (i % 2 ? 'echo' : 'n1z')).join(' '),
        ),
      ],
      (words: string[]) =>
        words.map((_, i) => (i % 2 ? 'echo' : 'n1z')).join(' '),
    ],
    [
      'every word moved (made again in reverse, past the exact bound)',
      (words: string[]) => [$createTextNode(words.join(' '))],
      (words: string[]) => [$createTextNode([...words].reverse().join(' '))],
      (words: string[]) => [...words].reverse().join(' '),
    ],
    [
      'the white space between every two words, one node per word',
      perWord(' '),
      perWord('  '),
      (words: string[]) => words.join('  '),
    ],
  ] as const) {
    test(
      name,
      async () => {
        // The faster of two runs of each length, so that a first run of a
        // path (compiled while it runs) or a collection does not count.
        const best = async (n: number) =>
          Math.min(
            await timed(n, oldNodes, newNodes, expected),
            await timed(n, oldNodes, newNodes, expected),
          );
        await timed(500, oldNodes, newNodes, expected);
        const small = await best(1_000);
        const big = await best(4_000);
        // Linear is 4x, quadratic 16x.
        expect(big / Math.max(small, 20)).toBeLessThan(10);
      },
      120_000,
    );
  }
});

// What a remade line keeps, checked against an independent longest common
// subsequence: as many words as the longest common run of words, for lines
// of any length up to the exact diff's bound of 2,048 edits among the words
// both texts have; past it (a line made again in reverse), only its common
// start and end, still runs of equal text in order in both texts.
describe('#9621: the kept words of a remade line', () => {
  const lcs = (a: string[], b: string[]) => {
    let row = Array<number>(b.length + 1).fill(0);
    for (const x of a) {
      const next = [0];
      for (let j = 0; j < b.length; j++) {
        next.push(x === b[j] ? row[j] + 1 : Math.max(row[j + 1], next[j]));
      }
      row = next;
    }
    return row[b.length];
  };
  /** The words kept, checking that each range is equal text, in order. */
  const kept = (a: string[], b: string[]) => {
    const aa = 'old0z ' + a.join(' ') + ' old1z';
    const bb = 'new0z ' + b.join(' ') + ' new1z';
    let lastA = 0;
    let lastB = 0;
    let n = 0;
    for (const [x0, x1, dx] of keptStretches(aa, bb, -1, false)) {
      expect(x0).toBeGreaterThanOrEqual(lastB);
      expect(x0 + dx).toBeGreaterThanOrEqual(lastA);
      expect(bb.slice(x0, x1)).toBe(aa.slice(x0 + dx, x1 + dx));
      n += (bb.slice(x0, x1).match(/w\d+z/g) ?? []).length;
      lastA = x1 + dx;
      lastB = x1;
    }
    return n;
  };
  test('a longest common run of words, with repeated words, short and long lines', () => {
    const rnd = random(9621);
    for (let k = 0; k < 1100; k++) {
      const vocab = 2 + rnd(k < 1000 ? 6 : 40);
      const a = Array.from(
        {length: 1 + rnd(k < 1000 ? 40 : 400)},
        () => `w${rnd(vocab)}z`,
      );
      const b = a
        .map(w => (rnd(3) === 0 ? `w${rnd(2 * vocab)}z` : w))
        .filter(() => rnd(8) > 0);
      expect(kept(a, b)).toBe(lcs(a, b));
    }
  }, 60_000);
  test('past the exact bound: equal runs in order', () => {
    const a = Array.from({length: 3000}, (_, i) => `w${i}z`);
    expect(kept(a, [...a].reverse())).toBeGreaterThanOrEqual(0);
    const rnd = random(9622);
    for (let k = 0; k < 20; k++) {
      const b = [...a];
      for (let i = 0; i < 2000; i++) {
        const x = rnd(b.length);
        const y = rnd(b.length);
        [b[x], b[y]] = [b[y], b[x]];
      }
      expect(kept(a, b)).toBeGreaterThanOrEqual(0);
    }
  });
});
