/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A range delete across text nodes that Lexical then merges: a link holding
// `da ` | *`da `* | `da `, then `t4z`; A deletes [2,7), and Lexical merges
// `da` and `a ` into `daa `. The write deletes ` da d` only, the merged
// characters keeping their items, so a peer's concurrent delete of the
// first `da `, or its typing in it, stays where it was made (soak S4-1:
// the delete was written as a replacement of the merged text, a deleted
// word came back and typing moved). Outside a link, and with other
// letters, the controls.
import {$createLinkNode} from '@lexical/link';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  type ElementNode,
  type TextFormatType,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {type Peer, setup} from '../utils/harness';

/** A range [from, to) of the line's text, over its text nodes. */
function $range(line: ElementNode, from: number, to: number) {
  const spans: [TextNode, number, number][] = [];
  let acc = 0;
  for (const t of line.getAllTextNodes()) {
    spans.push([t, acc, acc + t.getTextContentSize()]);
    acc += t.getTextContentSize();
  }
  const at = (o: number, start: boolean): [string, number] => {
    for (let i = 0; i < spans.length; i++) {
      const [t, a, b] = spans[i];
      if ((start ? o < b : o <= b) || i === spans.length - 1) {
        return [t.getKey(), o - a];
      }
    }
    throw new Error('offset');
  };
  const sel = $createRangeSelection();
  const [ak, ao] = at(from, from !== to);
  const [fk, fo] = at(to, false);
  sel.anchor.set(ak, ao, 'text');
  sel.focus.set(fk, fo, 'text');
  $setSelection(sel);
  return sel;
}

const $line = () => $getRoot().getChildAtIndex(1) as ElementNode;
const shown = (p: Peer) => p.read(() => $line().getTextContent());

function written(p: Peer) {
  const w = {deleted: '', inserted: ''};
  p.doc.on('afterTransaction', (tr: Y.Transaction) => {
    if (!tr.local) {
      return;
    }
    Y.iterateStructsByIdSet(tr, tr.insertSet, s => {
      if (s instanceof Y.Item && s.content instanceof Y.ContentString) {
        w.inserted += s.content.str;
      }
    });
    Y.iterateStructsByIdSet(tr, tr.deleteSet, s => {
      if (s instanceof Y.Item && s.content instanceof Y.ContentString) {
        w.deleted += s.content.str;
      }
    });
  });
  return w;
}

// [label, texts (the middle one italic), delete [from, to), peer edit, expected]
const CASES = [
  ['equal words', ['da ', 'da ', 'da '], [2, 7], 'delete [0,3)', 'a t4z'],
  ['equal words', ['da ', 'da ', 'da '], [2, 7], 'type X at 1', 'dXaa t4z'],
  ['other letters', ['ab', 'cd', 'ef'], [1, 5], 'delete [0,1)', 'ft4z'],
  ['other letters', ['ab', 'cd', 'ef'], [1, 5], 'type X at 6', 'afXt4z'],
] as const;

describe('a delete inside a link that merges its text nodes', () => {
  for (const inLink of [true, false]) {
    for (const [label, texts, [from, to], edit, expected] of CASES) {
      for (const ids of [
        [1, 2],
        [2, 1],
      ]) {
        test(`${inLink ? 'in a link' : 'no link'}, ${label}: A deletes [${from},${to}) while B ${edit} (ids ${ids})`, async () => {
          const t = await setup(
            () => {
              const nodes = [
                $createTextNode(texts[0]),
                $createTextNode(texts[1]).toggleFormat('italic'),
                $createTextNode(texts[2]),
              ];
              $getRoot().append(
                $createParagraphNode().append($createTextNode('Title')),
                $createParagraphNode().append(
                  ...(inLink
                    ? [$createLinkNode('https://a.example').append(...nodes)]
                    : nodes),
                  $createTextNode('t4z'),
                ),
              );
            },
            {ids},
          );
          const w = written(t.a);
          t.offline();
          t.a.update(() => {
            $range($line(), from, to).removeText();
            $setSelection(null);
          });
          const wrote = {...w};
          t.b.update(() => {
            const [op, arg] = edit.split(' at ');
            if (op === 'type X') {
              const k = Number(arg);
              $range($line(), k, k).insertText('X');
            } else {
              const [a, b] = edit.slice(8, -1).split(',').map(Number);
              $range($line(), a, b).removeText();
            }
            $setSelection(null);
          });
          await t.sync();
          // The author's own write deletes only the deleted characters.
          expect({a: shown(t.a), b: shown(t.b), wrote}).toEqual({
            a: expected,
            b: expected,
            wrote: {
              deleted: [...texts, 't4z'].join('').slice(from, to),
              inserted: '',
            },
          });
        });
      }
    }
  }
});

// Random range deletes over 3 or 4 text nodes, the first and last of the
// range in one format (so Lexical merges what is left of them), the caret
// left at the join: every write deletes exactly the removed characters and
// inserts none (soak S4-1's scan: 214 of 600 were written wrong before). And
// with the selection cleared in the same update, where Lexical's record of
// text edits says what was deleted (102 of 600 deleted an equal run of the
// right length elsewhere before it).
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

for (const caret of [true, false]) {
  test(`600 random range deletes over text nodes that merge are written as those deletes${caret ? '' : ', the selection cleared'}`, async () => {
    const fails: string[] = [];
    for (let seed = 1; seed <= 600; seed++) {
      const r = rng(seed);
      const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)];
      const k = 3 + Math.floor(r() * 2);
      const nodes: [string, TextFormatType | null][] = [];
      for (let i = 0; i < k; i++) {
        nodes.push([
          pick(['la ', 'da ', 'ab', 'cd ', 't6z ', 't7z ', 'xy z ']),
          i % 2 === 1
            ? pick(['bold', 'italic'] as const)
            : r() < 0.3
              ? 'underline'
              : null,
        ]);
      }
      const full = nodes.map(x => x[0]).join('');
      const starts: number[] = [];
      let acc0 = 0;
      for (const [x] of nodes) {
        starts.push(acc0);
        acc0 += x.length;
      }
      const i = Math.floor(r() * (k - 2));
      const j = i + 2 + Math.floor(r() * (k - i - 2));
      nodes[j][1] = nodes[i][1];
      const from = starts[i] + Math.floor(r() * nodes[i][0].length);
      const to = starts[j] + 1 + Math.floor(r() * (nodes[j][0].length - 1));
      const t = await setup(() => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('Title')),
          $createParagraphNode().append(
            ...nodes.map(([x, f]) => {
              const n = $createTextNode(x);
              if (f !== null) {
                n.toggleFormat(f);
              }
              return n;
            }),
          ),
        );
      });
      const w = written(t.a);
      t.a.update(() => {
        $range($line(), from, to).removeText();
        if (!caret) {
          $setSelection(null);
        }
      });
      if (w.deleted !== full.slice(from, to) || w.inserted !== '') {
        fails.push(`seed ${seed}: ${JSON.stringify(w)}`);
      }
    }
    expect(fails).toEqual([]);
  }, 60000);
}

// The same deletes made by app code through extract(): it splits the range's
// first and last text nodes, the app removes what it extracted, with no
// caret, and Lexical merges what is left (the last node's rest is a node new
// in this update, `t8z ` cut into `t8` and `z `). Lexical records the split
// (EditorState#_splitNodes): the rest keeps the characters of the node it
// was split from, so the write deletes exactly the range (soak S4-1 through
// extract(): 20 of 32 wrote `t7z t8z ` deleted and `z ` inserted, or kept
// an equal run of another node). Also at the line's end.
const EXTRACT_CASES = [
  ...CASES.map(c => [...c, true] as const),
  [
    'equal words at the line end',
    ['da ', 'da ', 'da '],
    [2, 7],
    'delete [0,3)',
    'a ',
    false,
  ],
  [
    'equal words at the line end',
    ['da ', 'da ', 'da '],
    [2, 7],
    'type X at 1',
    'dXaa ',
    false,
  ],
  [
    'other words at the line end',
    ['t6z ', 't7z ', 't8z '],
    [4, 10],
    'delete [10,12)',
    't6z ',
    false,
  ],
  [
    'other words at the line end',
    ['t6z ', 't7z ', 't8z '],
    [4, 10],
    'type X at 11',
    't6z zX ',
    false,
  ],
] as const;

/** App code: extract the range and remove what it extracted (no caret). */
function $extractAndRemove(line: ElementNode, from: number, to: number) {
  const nodes = $range(line, from, to).extract();
  $setSelection(null);
  for (const n of nodes) {
    n.remove();
  }
}

describe('a delete through extract() that merges text nodes', () => {
  for (const inLink of [true, false]) {
    for (const [
      label,
      texts,
      [from, to],
      edit,
      expected,
      tail,
    ] of EXTRACT_CASES) {
      for (const ids of [
        [1, 2],
        [2, 1],
      ]) {
        test(`${inLink ? 'in a link' : 'no link'}, ${label}: A extracts and removes [${from},${to}) while B ${edit} (ids ${ids})`, async () => {
          const t = await setup(
            () => {
              const nodes = [
                $createTextNode(texts[0]),
                $createTextNode(texts[1]).toggleFormat('italic'),
                $createTextNode(texts[2]),
              ];
              $getRoot().append(
                $createParagraphNode().append($createTextNode('Title')),
                $createParagraphNode().append(
                  ...(inLink
                    ? [$createLinkNode('https://a.example').append(...nodes)]
                    : nodes),
                  ...(tail ? [$createTextNode('t4z')] : []),
                ),
              );
            },
            {ids},
          );
          const w = written(t.a);
          t.offline();
          t.a.update(() => {
            $extractAndRemove($line(), from, to);
          });
          const wrote = {...w};
          t.b.update(() => {
            const [op, arg] = edit.split(' at ');
            if (op === 'type X') {
              const k = Number(arg);
              $range($line(), k, k).insertText('X');
            } else {
              const [a, b] = edit.slice(8, -1).split(',').map(Number);
              $range($line(), a, b).removeText();
            }
            $setSelection(null);
          });
          await t.sync();
          expect({a: shown(t.a), b: shown(t.b), wrote}).toEqual({
            a: expected,
            b: expected,
            wrote: {
              deleted: [...texts, tail ? 't4z' : ''].join('').slice(from, to),
              inserted: '',
            },
          });
        });
      }
    }
  }
});

test('600 random range deletes through extract() are written as those deletes', async () => {
  const fails: string[] = [];
  for (let seed = 1; seed <= 600; seed++) {
    const r = rng(seed);
    const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)];
    const k = 3 + Math.floor(r() * 2);
    const nodes: [string, TextFormatType | null][] = [];
    for (let i = 0; i < k; i++) {
      nodes.push([
        pick(['la ', 'da ', 'ab', 'cd ', 't6z ', 't7z ', 'xy z ']),
        i % 2 === 1
          ? pick(['bold', 'italic'] as const)
          : r() < 0.3
            ? 'underline'
            : null,
      ]);
    }
    const full = nodes.map(x => x[0]).join('');
    const starts: number[] = [];
    let acc0 = 0;
    for (const [x] of nodes) {
      starts.push(acc0);
      acc0 += x.length;
    }
    const i = Math.floor(r() * (k - 2));
    const j = i + 2 + Math.floor(r() * (k - i - 2));
    nodes[j][1] = nodes[i][1];
    const from = starts[i] + Math.floor(r() * nodes[i][0].length);
    const to = starts[j] + 1 + Math.floor(r() * (nodes[j][0].length - 1));
    const t = await setup(() => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('Title')),
        $createParagraphNode().append(
          ...nodes.map(([x, f]) => {
            const n = $createTextNode(x);
            if (f !== null) {
              n.toggleFormat(f);
            }
            return n;
          }),
        ),
      );
    });
    const w = written(t.a);
    t.a.update(() => {
      $extractAndRemove($line(), from, to);
    });
    if (w.deleted !== full.slice(from, to) || w.inserted !== '') {
      fails.push(`seed ${seed}: ${JSON.stringify(w)}`);
    }
  }
  expect(fails).toEqual([]);
}, 60000);
