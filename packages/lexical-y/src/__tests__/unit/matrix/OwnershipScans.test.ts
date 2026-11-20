/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Ownership scans: the binding decides that an item belongs to a write or a
// client (a run's own end, a hole a write opened, the run ends an undo
// keeps, the opening write of a node Lexical keeps apart). These cells give that decision neighbours of the SAME client from
// DIFFERENT writes: B gives "Kilo" a value, types plain " zz" elsewhere,
// gives "cc" the same value, then undoes 0 to 3 of those writes while A,
// at the same time, edits inside "Kilo" (types plain text, removes the value
// from "il", or deletes a letter). Every value kind: bold, code, a comment
// (set-valued NodeState) and a link. Both client id orders.
//
// The contract, from a model of the edits rather than from another tree:
// the peers converge on what a fresh reader of the document shows; text
// that nobody gave the value never has it (it never runs on past a range a
// write gave it); text a live write gave the value keeps it, unless A
// removed it there; text a collaborator typed plain stays plain. Text inside
// a range whose write was undone may keep the value after A's concurrent
// edit (a documented limit of undo), so the model leaves it free.

import {
  $createHashtagNode,
  $isHashtagNode,
  HashtagNode,
} from '@lexical/hashtag';
import {$isLinkNode, $toggleLink} from '@lexical/link';
import {$addMarkID, $getNodeMarkIDs, $removeMarkID} from '@lexical/mark';
import {
  $createTabNode,
  $createTextNode,
  $getRoot,
  $isTabNode,
  $setSelection,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $locateIn,
  $p,
  $selectIn,
  expectConverged,
  NODES,
  type Peer,
  setup,
} from '../../utils/harness';
import {prepareMarkState} from '../../utils/sizeOps';

type Value = 'bold' | 'code' | 'comment' | 'link';
type Edit = 'type plain' | 'remove the value' | 'delete a letter';

const VALUES: Value[] = ['bold', 'code', 'comment', 'link'];
const EDITS: Edit[] = ['type plain', 'remove the value', 'delete a letter'];
const LINE = 'aa Kilo bb cc dd';
const KILO: [number, number] = [3, 7];
const CC: [number, number] = [11, 13];
const IL: [number, number] = [4, 6];

function $give(value: Value, from: number, to: number) {
  const selection = $selectIn([0], from, to);
  if (value === 'comment') {
    $addMarkID('c1', selection);
  } else if (value === 'link') {
    $toggleLink('https://example.com');
  } else {
    selection.format = (selection.anchor.getNode() as TextNode).getFormat();
    selection.formatText(value);
  }
  $setSelection(null);
}

function $remove(value: Value, from: number, to: number) {
  const selection = $selectIn([0], from, to);
  if (value === 'comment') {
    $removeMarkID('c1', selection);
  } else if (value === 'link') {
    $toggleLink(null);
  } else {
    selection.format = (selection.anchor.getNode() as TextNode).getFormat();
    selection.formatText(value);
  }
  $setSelection(null);
}

/** Inserts `inserted` at `offset` of the first line. */
function $insertAt(offset: number, inserted: LexicalNode) {
  const [node, at] = $locateIn($block([0]), offset);
  if (at === 0) {
    node.insertBefore(inserted);
  } else if (at === node.getTextContentSize()) {
    node.insertAfter(inserted);
  } else {
    node.splitText(at)[1].insertBefore(inserted);
  }
}

/** Inserts an unformatted text node at `offset` of the first line. */
function $insertPlainAt(offset: number, text: string) {
  $insertAt(offset, $createTextNode(text));
}

function $has(value: Value, node: TextNode): boolean {
  switch (value) {
    case 'comment':
      return $getNodeMarkIDs(node as LexicalNode).includes('c1');
    case 'link':
      return $isLinkNode(node.getParent());
    default:
      return node.hasFormat(value);
  }
}

/** Each character of a line with whether it has the value. */
function chars(peer: Peer, value: Value, line: number): [string, boolean][] {
  return peer.read(() =>
    ($block([line]).getAllTextNodes() as TextNode[]).flatMap(node =>
      Array.from(node.getTextContent(), c => [c, $has(value, node)] as const),
    ),
  ) as [string, boolean][];
}

type Origin = {kind: 'line'; index: number} | {kind: 'zz'} | {kind: 'A'};

/**
 * The model: the text the edits leave, and for each character whether it
 * must have the value (true), must not (false), or may either (null).
 */
function model(
  value: Value,
  edit: Edit,
  undos: number,
): {text: string; want: (boolean | null)[]} {
  const kiloLive = undos < 3;
  const zzLive = undos < 2;
  const ccLive = undos < 1;
  const out: [string, Origin][] = [];
  for (let i = 0; i < LINE.length; i++) {
    if (edit === 'delete a letter' && i === 5) {
      continue;
    }
    if (edit === 'type plain' && i === 5) {
      out.push(['X', {kind: 'A'}]);
    }
    if (zzLive && i === 10) {
      for (const c of ' zz') {
        out.push([c, {kind: 'zz'}]);
      }
    }
    out.push([LINE[i], {index: i, kind: 'line'}]);
  }
  const want = out.map(([, origin]): boolean | null => {
    if (origin.kind === 'zz') {
      return false;
    }
    if (origin.kind === 'A') {
      // Typed plain; inside a link node it is part of the link.
      return value === 'link' ? null : false;
    }
    const i = origin.index;
    if (i >= KILO[0] && i < KILO[1]) {
      if (!kiloLive) {
        return null;
      }
      return !(edit === 'remove the value' && i >= IL[0] && i < IL[1]);
    }
    if (i >= CC[0] && i < CC[1]) {
      return ccLive;
    }
    return false;
  });
  return {text: out.map(([c]) => c).join(''), want};
}

describe('ownership scans: one client writes the value, types, writes it again', () => {
  for (const value of VALUES) {
    for (const edit of EDITS) {
      for (let undos = 0; undos <= 3; undos++) {
        for (const ids of [
          [1, 2],
          [2, 1],
        ]) {
          test(`${value}, A ${edit} inside the first run, B undoes ${undos} (ids ${ids})`, async () => {
            const t = await setup(
              () => $getRoot().append($p(LINE), $p('tail line')),
              {ids, prepare: prepareMarkState},
            );
            t.b.update(() => $give(value, ...KILO));
            await t.sync();
            t.b.update(() => $insertPlainAt(10, ' zz'));
            await t.sync();
            t.b.update(() => $give(value, 14, 16));
            await t.sync();
            t.offline();
            for (let i = 0; i < undos; i++) {
              t.b.undo();
            }
            t.a.update(() => {
              if (edit === 'type plain') {
                $insertPlainAt(5, 'X');
              } else if (edit === 'remove the value') {
                $remove(value, ...IL);
              } else {
                const [node, at] = $locateIn($block([0]), 5);
                node.spliceText(at, 1, '');
              }
            });
            await t.sync();
            await expectConverged(t.peers);
            const expected = model(value, edit, undos);
            const line = chars(t.a, value, 0);
            const problems: string[] = [];
            if (line.map(([c]) => c).join('') !== expected.text) {
              problems.push(
                `text ${JSON.stringify(line.map(([c]) => c).join(''))} != ${JSON.stringify(expected.text)}`,
              );
            } else {
              line.forEach(([c, got], i) => {
                const want = expected.want[i];
                if (want !== null && want !== got) {
                  problems.push(
                    `"${c}" at ${i} ${got ? 'has' : 'lacks'} the ${value}`,
                  );
                }
              });
            }
            if (chars(t.a, value, 1).some(([, got]) => got)) {
              problems.push(`the next line has the ${value}`);
            }
            expect(problems).toEqual([]);
          });
        }
      }
    }
  }
});

// The same shape with nodes Lexical keeps apart (a tab, a token, a segmented
// node, a hashtag): B writes one before "Kilo", types plain " zz", writes
// another before "cc", then undoes 0 to 3 of those writes while A types
// plain text right after or right before the first one, or deletes the
// letter after it. The kept-apart nodes stay what they are and nothing else
// becomes one: every other character is plain text.
type Opener = 'tab' | 'token' | 'segmented' | 'hashtag';
type OpenerEdit =
  | 'type after it'
  | 'type before it'
  | 'delete the letter after it'
  | 'write one and text before it';

const OPENERS: Record<Opener, string> = {
  hashtag: '#tag',
  segmented: 'seg ment',
  tab: '\t',
  token: 'tok',
};
const OPENER_EDITS: OpenerEdit[] = [
  'type after it',
  'type before it',
  'delete the letter after it',
  'write one and text before it',
];

function $opener(kind: Opener): LexicalNode {
  switch (kind) {
    case 'tab':
      return $createTabNode();
    case 'hashtag':
      return $createHashtagNode(OPENERS.hashtag);
    default:
      return $createTextNode(OPENERS[kind]).setMode(kind);
  }
}

function kindOf(node: TextNode): string {
  if ($isTabNode(node)) {
    return 'tab';
  }
  if ($isHashtagNode(node)) {
    return 'hashtag';
  }
  return node.getMode() === 'normal' ? 'plain' : node.getMode();
}

describe('ownership scans: one client writes a node kept apart, types, writes another', () => {
  for (const kind of Object.keys(OPENERS) as Opener[]) {
    const w = OPENERS[kind];
    for (const edit of OPENER_EDITS) {
      for (let undos = 0; undos <= 3; undos++) {
        for (const ids of [
          [1, 2],
          [2, 1],
        ]) {
          test(`${kind}, A ${edit}, B undoes ${undos} (ids ${ids})`, async () => {
            const t = await setup(
              () => $getRoot().append($p(LINE), $p('tail line')),
              {ids, nodes: [...NODES, HashtagNode]},
            );
            t.b.update(() => $insertAt(3, $opener(kind)));
            await t.sync();
            t.b.update(() => $insertPlainAt(10 + w.length, ' zz'));
            await t.sync();
            t.b.update(() => $insertAt(14 + w.length, $opener(kind)));
            await t.sync();
            t.offline();
            for (let i = 0; i < undos; i++) {
              t.b.undo();
            }
            t.a.update(() => {
              if (edit === 'type after it') {
                $insertPlainAt(3 + w.length, 'X');
              } else if (edit === 'type before it') {
                $insertPlainAt(3, 'X');
              } else if (edit === 'write one and text before it') {
                $insertPlainAt(3, 'Y');
                $insertAt(3, $opener(kind));
              } else {
                const [node, at] = $locateIn($block([0]), 3 + w.length);
                node.spliceText(at, 1, '');
              }
            });
            await t.sync();
            await expectConverged(t.peers);
            // The model: each character and what it must be.
            const firstLive = undos < 3;
            const zzLive = undos < 2;
            const secondLive = undos < 1;
            const want: [string, string][] = [];
            for (let i = 0; i < LINE.length; i++) {
              if (i === 3) {
                if (edit === 'type before it') {
                  want.push(['X', 'plain']);
                }
                if (edit === 'write one and text before it') {
                  for (const c of w) {
                    want.push([c, kind]);
                  }
                  want.push(['Y', 'plain']);
                }
                if (firstLive) {
                  for (const c of w) {
                    want.push([c, kind]);
                  }
                }
                if (edit === 'type after it') {
                  want.push(['X', 'plain']);
                }
                if (edit === 'delete the letter after it') {
                  continue;
                }
              }
              if (i === 10 && zzLive) {
                for (const c of ' zz') {
                  want.push([c, 'plain']);
                }
              }
              if (i === 11 && secondLive) {
                for (const c of w) {
                  want.push([c, kind]);
                }
              }
              want.push([LINE[i], 'plain']);
            }
            const got = t.a.read(() =>
              ($block([0]).getAllTextNodes() as TextNode[]).flatMap(node =>
                Array.from(
                  node.getTextContent(),
                  c => [c, kindOf(node)] as [string, string],
                ),
              ),
            );
            const nextLine = t.a.read(() =>
              ($block([1]).getAllTextNodes() as TextNode[]).map(kindOf),
            );
            expect({got, nextLine}).toEqual({got: want, nextLine: ['plain']});
          });
        }
      }
    }
  }
});

// A run with a neighbouring run of the same key right after it (a second
// comment, another link, or an italic run next to a bold one), one write of
// plain text inside the first run (at its start, middle or end), then the
// writer undoes it while a collaborator who saw the write deletes past the
// run's end (1, 2 or 3 characters, or its last character and then the next
// word), so the deleted gap holds the neighbour's items. Nothing outside
// the first run may gain or lose its value: the run keeps it, the neighbour
// keeps its own, and every other character stays plain.
type Neighbour = 'comment' | 'link' | 'bold next to italic';
const NEIGHBOURS: Neighbour[] = ['comment', 'link', 'bold next to italic'];
const DELETES: [string, [number, number][]][] = [
  ['1 character', [[7, 8]]],
  [
    '2 characters',
    [
      [7, 8],
      [7, 8],
    ],
  ],
  [
    '3 characters',
    [
      [7, 8],
      [7, 8],
      [7, 8],
    ],
  ],
  [
    'the last character, then the next word',
    [
      [7, 8],
      [7, 10],
    ],
  ],
];

function $giveNeighbour(
  kind: Neighbour,
  run: boolean,
  from: number,
  to: number,
) {
  const selection = $selectIn([0], from, to);
  if (kind === 'comment') {
    $addMarkID(run ? 'c1' : 'c2', selection);
  } else if (kind === 'link') {
    $toggleLink(run ? 'https://one.example' : 'https://two.example');
  } else {
    selection.format = (selection.anchor.getNode() as TextNode).getFormat();
    selection.formatText(run ? 'bold' : 'italic');
  }
  $setSelection(null);
}

/** What a character carries: the run's value (1), the neighbour's (2). */
function $carried(kind: Neighbour, node: TextNode): string {
  if (kind === 'comment') {
    return $getNodeMarkIDs(node as LexicalNode)
      .sort()
      .join(',');
  }
  if (kind === 'link') {
    const parent = node.getParent();
    return $isLinkNode(parent)
      ? parent.getURL() === 'https://one.example'
        ? 'c1'
        : 'c2'
      : '';
  }
  return [
    node.hasFormat('bold') ? 'c1' : '',
    node.hasFormat('italic') ? 'c2' : '',
  ]
    .filter(Boolean)
    .join(',');
}

describe('ownership scans: an undone write inside a run, a delete past its end into a neighbouring run', () => {
  for (const kind of NEIGHBOURS) {
    for (const at of [4, 5, 6]) {
      for (const [deleteName, deletes] of DELETES) {
        for (const withBlockIds of [false, true]) {
          for (const ids of [
            [1, 2],
            [2, 1],
          ]) {
            test(`${kind}, write at ${at}, B deletes ${deleteName}${withBlockIds ? ', block ids' : ''} (ids ${ids})`, async () => {
              const t = await setup(
                () => $getRoot().append($p(LINE), $p('tail line')),
                {ids, prepare: prepareMarkState, withBlockIds},
              );
              t.a.update(() => $giveNeighbour(kind, true, ...KILO));
              t.b.update(() => $giveNeighbour(kind, false, 8, 10));
              await t.sync();
              t.a.update(() => $insertPlainAt(at, 'X'));
              await t.sync();
              t.offline();
              t.a.undo();
              for (const [from, to] of deletes) {
                t.b.update(() => void $selectIn([0], from, to).removeText());
              }
              await t.sync();
              await expectConverged(t.peers);
              // The model: B deletes from the text with A's write, then
              // A's undo takes the write out.
              const tagged: [string, string][] = Array.from(LINE, (c, i) => [
                c,
                i >= KILO[0] && i < KILO[1]
                  ? 'c1'
                  : i >= 8 && i < 10
                    ? 'c2'
                    : '',
              ]);
              tagged.splice(at, 0, ['X', 'write']);
              for (const [from, to] of deletes) {
                tagged.splice(from, to - from);
              }
              const want = tagged.filter(([, tag]) => tag !== 'write');
              const got = t.a.read(() =>
                ($block([0]).getAllTextNodes() as TextNode[]).flatMap(node =>
                  Array.from(
                    node.getTextContent(),
                    c => [c, $carried(kind, node)] as [string, string],
                  ),
                ),
              );
              const nextLine = t.a.read(() =>
                ($block([1]).getAllTextNodes() as TextNode[]).map(node =>
                  $carried(kind, node),
                ),
              );
              expect({got, nextLine}).toEqual({got: want, nextLine: ['']});
            });
          }
        }
      }
    }
  }
});
