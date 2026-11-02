/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// #9666: text set whole with `setTextContent` kept only its common start and
// end with the old text, so with two or more words changed everything
// between the first and the last change was written again: a word a
// collaborator deleted there at the same time came back, and showed twice
// after the collaborator's undo (#9621's shape, which #9625 fixed for text
// made again). Set text now keeps every run of unchanged words between its
// changes too (D29's word diff), recorded or diffed by the writer, and a
// caret still places a single insertion or deletion (#9641, #9657).

import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test, vi} from 'vitest';

import {Cursor} from '../../../internal/Cursor';
import {
  $selectIn,
  expectConverged,
  flush,
  freshReader,
  type Peer,
  setup,
} from '../../utils/harness';

const $line = () => $getRoot().getChildAtIndex(1) as ElementNode;
const $node = () => $line().getFirstChildOrThrow() as TextNode;
const lineText = (p: Peer) => p.read(() => $line().getTextContent());

const $splice =
  (at: number, n: number, insert = '') =>
  () => {
    $node().spliceText(at, n, insert, false);
    $setSelection(null);
  };

const IDS = [
  [1, 2],
  [2, 1],
];
const RECORD = [true, false];

const LINE = 't1z t2z t3z t4z t5z t6z t7z';

describe('#9666: a delete between two words setTextContent changes stays deleted', () => {
  for (const ids of IDS) {
    for (const record of RECORD) {
      const how = record ? 'recorded' : 'diffed by the writer';
      for (const [name, next, sync, undo] of [
        [
          'two words changed',
          't1z n9z t3z t4z t5z t6z n8z',
          't1z n9z t3z t4z t6z n8z',
          't1z n9z t3z t4z t5z t6z n8z',
        ],
        [
          'control: one word changed',
          't1z t2z t3z t4z t5z t6z n8z',
          't1z t2z t3z t4z t6z n8z',
          't1z t2z t3z t4z t5z t6z n8z',
        ],
        [
          'three words changed, one removed',
          'n1z t2z t4z t5z n6z t7z',
          'n1z t2z t4z n6z t7z',
          'n1z t2z t4z t5z n6z t7z',
        ],
      ] as const) {
        test(`${name}, ${how} (ids ${ids})`, async () => {
          const t = await setup(
            () => {
              $getRoot().append(
                $createParagraphNode().append($createTextNode('Title')),
                $createParagraphNode().append($createTextNode(LINE)),
              );
            },
            {ids},
          );
          const recording = t.a.editor._recordTextEdits;
          try {
            t.a.editor._recordTextEdits = record;
            t.offline();
            t.b.update($splice(LINE.indexOf('t5z') - 1, 4));
            t.a.update(() => {
              $node().setTextContent(next);
              $setSelection(null);
            });
            await t.sync();
            expect(t.peers.map(lineText)).toEqual([sync, sync]);
            t.b.undo();
            await t.sync();
            const fresh = await freshReader(t.a);
            expect([...t.peers, fresh].map(lineText)).toEqual([
              undo,
              undo,
              undo,
            ]);
            await expectConverged(t.peers);
          } finally {
            t.a.editor._recordTextEdits = recording;
          }
        });
      }
    }
  }
});

// A line of several text nodes, each set with its first and last words
// changed, while a collaborator deletes a word of the first: the writer's
// diff of each changed node keeps its unchanged words (as the record does).
describe('#9666: several text nodes of a line set at once', () => {
  for (const n of [2, 4, 16]) {
    for (const ids of IDS) {
      for (const record of RECORD) {
        const how = record ? 'recorded' : 'diffed by the writer';
        test(`${n} nodes, ${how} (ids ${ids})`, async () => {
          const old = Array.from(
            {length: n},
            (_, i) => `old${i} keep${i} end${i}` + (i < n - 1 ? ' ' : ''),
          );
          const next = Array.from(
            {length: n},
            (_, i) => `new${i} keep${i} tail${i}` + (i < n - 1 ? ' ' : ''),
          );
          const t = await setup(
            () => {
              $getRoot().append(
                $createParagraphNode().append($createTextNode('Title')),
                $createParagraphNode().append(
                  ...old.map((text, i) =>
                    $createTextNode(text).setFormat(i % 2),
                  ),
                ),
              );
            },
            {ids},
          );
          const recording = t.a.editor._recordTextEdits;
          try {
            t.a.editor._recordTextEdits = record;
            t.offline();
            t.b.update(() => {
              const leaf = $line().getFirstChildOrThrow() as TextNode;
              leaf.spliceText(5, 6, '', false);
              $setSelection(null);
            });
            t.a.update(() => {
              ($line().getChildren() as TextNode[]).forEach((leaf, i) =>
                leaf.setTextContent(next[i]),
              );
              $setSelection(null);
            });
            await t.sync();
            const want = next.join('').replace('keep0 ', '');
            const fresh = await freshReader(t.a);
            expect([...t.peers, fresh].map(lineText)).toEqual([
              want,
              want,
              want,
            ]);
            await expectConverged(t.peers);
          } finally {
            t.a.editor._recordTextEdits = recording;
          }
        });
      }
    }
  }
});

// The writer's diff of many text nodes set at once walks the line once:
// its cursor steps grow with the line, not with the line times the nodes.
test('#9666: many text nodes set at once, diffed by the writer, in one pass', async () => {
  const steps: number[] = [];
  for (const n of [256, 1024]) {
    const old = Array.from(
      {length: n},
      (_, i) => `old${i} keep${i} end${i}` + (i < n - 1 ? ' ' : ''),
    );
    const next = old.map(text =>
      text.replace('old', 'new').replace('end', 'tail'),
    );
    const t = await setup(() => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('Title')),
        $createParagraphNode().append(
          ...old.map((text, i) => $createTextNode(text).setFormat(i % 2)),
        ),
      );
    });
    const recording = t.a.editor._recordTextEdits;
    const forward = vi.spyOn(Cursor.prototype, 'forward');
    try {
      t.a.editor._recordTextEdits = false;
      t.a.update(() => {
        ($line().getChildren() as TextNode[]).forEach((leaf, i) =>
          leaf.setTextContent(next[i]),
        );
        $setSelection(null);
      });
      expect(lineText(t.a)).toBe(next.join(''));
      steps.push(forward.mock.calls.length);
    } finally {
      forward.mockRestore();
      t.a.editor._recordTextEdits = recording;
    }
  }
  // Four times the nodes: about four times the steps (it was sixteen).
  expect(steps[1] / steps[0]).toBeLessThan(6);
}, 60_000);

// A join and then a bold, two updates, while a collaborator bolds the same
// words and then deletes them: one undo undoes the bold only (the writer
// keeps the recorded path's lines of several changed nodes as they were).
describe('#9666: one undo undoes one update', () => {
  for (const ids of IDS) {
    test(`a join, then a bold ‖ the peer bolds and deletes (ids ${ids})`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('s1z s2z s3z s4z')),
            $createParagraphNode().append(
              $createTextNode('s5z s6z').setFormat(1),
            ),
          );
        },
        {ids},
      );
      t.offline();
      t.b.update(() => {
        $selectIn([0], 8, 15).formatText('bold');
        $setSelection(null);
      });
      t.a.update(() => {
        const [l1, l2] = $getRoot().getChildren() as ElementNode[];
        const last = l1.getLastDescendant() as TextNode;
        const first = l2.getFirstDescendant() as TextNode;
        const s = $createRangeSelection();
        s.anchor.set(last.getKey(), last.getTextContentSize(), 'text');
        s.focus.set(first.getKey(), 0, 'text');
        $setSelection(s);
        s.removeText();
        $setSelection(null);
      });
      t.a.update(() => {
        $selectIn([0], 8, 15).formatText('bold');
        $setSelection(null);
      });
      await t.sync();
      t.b.update(() => {
        $selectIn([0], 3, 15).removeText();
        $setSelection(null);
      });
      await t.sync();
      t.a.undo();
      await t.sync();
      expect(t.a.read(() => $getRoot().getChildrenSize())).toBe(1);
      await expectConverged(t.peers);
    });
  }
});

// A set that also changes the node's format: recorded, it keeps the
// unchanged words; diffed by the writer, the node is written whole (its
// attributes and text in one write, which does not diff the text), so the
// word a collaborator deleted comes back (#9666, open).
describe("#9666: a set that also changes the node's format", () => {
  for (const ids of IDS) {
    for (const record of RECORD) {
      const how = record ? 'recorded' : 'diffed by the writer';
      const run = async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('Title')),
              $createParagraphNode().append($createTextNode(LINE)),
            );
          },
          {ids},
        );
        const recording = t.a.editor._recordTextEdits;
        try {
          t.a.editor._recordTextEdits = record;
          t.offline();
          t.b.update($splice(LINE.indexOf('t5z') - 1, 4));
          t.a.update(() => {
            $node().setTextContent('t1z n9z t3z t4z t5z t6z n8z');
            $node().toggleFormat('bold');
            $setSelection(null);
          });
          await t.sync();
          const want = 't1z n9z t3z t4z t6z n8z';
          expect(t.peers.map(lineText)).toEqual([want, want]);
          await expectConverged(t.peers);
        } finally {
          t.a.editor._recordTextEdits = recording;
        }
      };
      if (record) {
        test(`${how} (ids ${ids})`, run);
      } else {
        test.fails(`${how} (ids ${ids}): #9666`, run);
      }
    }
  }
});

/** A seeded random integer below `n`. */
function random(seed: number) {
  let state = seed >>> 0 || 1;
  return (n: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % n;
  };
}

const SEEDS = Number(process.env.LEXICAL_Y_SEEDS || 60);
const EDITS = ['delete', 'type', 'delete then undo'] as const;

// A line set with 2 to 4 word edits (replaced, inserted, removed) while a
// collaborator edits a word the set keeps: their edit stays, nothing comes
// back, nothing shows twice, every word the set wrote is whole, and every
// client and a fresh reader agree.
describe('#9666: nothing a collaborator deleted comes back, nothing shows twice', () => {
  for (const record of RECORD) {
    for (const timing of ['unread', 'concurrent'] as const) {
      for (const edit of EDITS) {
        const how = record ? 'recorded' : 'diffed by the writer';
        test(`${timing}, ${how}: lines set with 2 to 4 word edits ‖ the peer ${edit}s an unchanged word`, async () => {
          const failures: string[] = [];
          for (let seed = 1; seed <= SEEDS; seed++) {
            const rnd = random(
              seed * 7919 +
                EDITS.indexOf(edit) * 131 +
                (timing === 'unread' ? 17 : 0) +
                (record ? 0 : 29),
            );
            const count = 4 + rnd(8);
            const numbers = new Set<number>();
            while (numbers.size < count + 4) {
              numbers.add(100 + rnd(900));
            }
            const pool = [...numbers].map(
              n => `t${n}z${['', '', '', ',', '.'][rnd(5)]}`,
            );
            const words = pool.slice(0, count);
            const fresh = pool.slice(count);
            const old = words.join(' ');
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
            const set = next.join(' ');
            const victim = unchanged[rnd(unchanged.length)];
            const vAt = old.indexOf(victim);
            const from = 1 + rnd(3);
            const len = 1 + rnd(4 - from);
            const ids = rnd(2) === 0 ? [1, 2] : [2, 1];
            const t = await setup(
              () => {
                $getRoot().append(
                  $createParagraphNode().append($createTextNode('Title')),
                  $createParagraphNode().append($createTextNode(old)),
                );
              },
              {ids},
            );
            const recording = t.a.editor._recordTextEdits;
            t.a.editor._recordTextEdits = record;
            const $set = () => {
              $node().setTextContent(set);
              $setSelection(null);
            };
            const $peer = edit.startsWith('delete')
              ? $splice(vAt + from, len)
              : $splice(vAt + from, 0, 'Q');
            t.offline();
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
            if (edit.endsWith('undo')) {
              t.b.undo();
              await t.sync();
            }
            t.a.editor._recordTextEdits = recording;
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
            if (problems.length > 0) {
              failures.push(
                `seed ${seed} ids ${ids} ${JSON.stringify(old)} -> ${JSON.stringify(set)}; ${edit} "${victim}" at ${from}+${len}: ${JSON.stringify(texts[0])}: ${problems.join(', ')}`,
              );
            }
          }
          expect(failures).toEqual([]);
        }, 240_000);
      }
    }
  }
});
