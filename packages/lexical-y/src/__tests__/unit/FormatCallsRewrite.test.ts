/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

/**
 * Soak 4 repro: a format-only update with two formatText calls on one line
 * is written as a rewrite of the words (deleted and inserted again): a
 * collaborator's concurrent delete there comes back, their typing moves.
 */
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
      if ((start ? o < b : o <= b) || i === spans.length - 1)
        return [t.getKey(), o - a];
    }
    throw new Error('o');
  };
  const s = $createRangeSelection();
  const [ak, ao] = at(from, true);
  const [fk, fo] = at(to, false);
  s.anchor.set(ak, ao, 'text');
  s.focus.set(fk, fo, 'text');
  return s;
}

const text = (p: Peer) =>
  p.read(() => ($getRoot().getChildAtIndex(1) as ElementNode).getTextContent());

const CASES: [
  string,
  [string, TextFormatType | null][],
  [TextFormatType, number, number][],
  boolean,
  string,
  string,
][] = [
  // runs, A's formats (in one update), caret cleared, B's edit, expected text
  [
    'italic then underline inside it',
    [
      ['ab', 'underline'],
      ['la ', 'italic'],
      ['la la ', null],
    ],
    [
      ['italic', 3, 9],
      ['underline', 7, 8],
    ],
    true,
    'delete [2,5)',
    'abla la ',
  ],
  [
    'italic then underline inside it',
    [
      ['ab', 'underline'],
      ['la ', 'italic'],
      ['la la ', null],
    ],
    [
      ['italic', 3, 9],
      ['underline', 7, 8],
    ],
    true,
    'type X at 4',
    'ablaX la la ',
  ],
  [
    'underline then italic around it',
    [
      ['xy z ', 'underline'],
      ['xy z ', null],
      ['ab', null],
      ['ab', 'italic'],
      ['t6z ', null],
    ],
    [
      ['underline', 15, 16],
      ['italic', 12, 16],
    ],
    false,
    'delete [12,14)',
    'xy z xy z abt6z ',
  ],
  [
    'bold, bold, italic',
    [
      ['xy z ', 'bold'],
      ['ab', null],
      ['la la ', null],
    ],
    [
      ['bold', 3, 12],
      ['bold', 0, 2],
      ['italic', 10, 11],
    ],
    false,
    'delete [5,7)',
    'xy z la la ',
  ],
];

describe('a format-only update with several formatText calls', () => {
  for (const [label, runs, fmts, nocaret, edit, expected] of CASES) {
    test(`${label}${nocaret ? ' (caret cleared)' : ''}; B ${edit}`, async () => {
      const t = await setup(() => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('Title')),
          $createParagraphNode().append(
            ...runs.map(([s, f]) => {
              const x = $createTextNode(s);
              if (f) x.toggleFormat(f);
              return x;
            }),
          ),
        );
      });
      const w = {deleted: '', inserted: ''};
      t.a.doc.on('afterTransaction', (tr: Y.Transaction) => {
        if (!tr.local) return;
        Y.iterateStructsByIdSet(tr, tr.insertSet, s => {
          if (s instanceof Y.Item && s.content instanceof Y.ContentString)
            w.inserted += s.content.str;
        });
        Y.iterateStructsByIdSet(tr, tr.deleteSet, s => {
          if (s instanceof Y.Item && s.content instanceof Y.ContentString)
            w.deleted += s.content.str;
        });
      });
      t.offline();
      t.a.update(() => {
        const line = $getRoot().getChildAtIndex(1) as ElementNode;
        for (const [f, a, b] of fmts) {
          const s = $range(line, a, b);
          $setSelection(s);
          s.formatText(f);
        }
        if (nocaret) $setSelection(null);
      });
      const wrote = {...w};
      t.b.update(() => {
        const line = $getRoot().getChildAtIndex(1) as ElementNode;
        if (edit.startsWith('type X at ')) {
          const k = Number(edit.slice(10));
          $range(line, k, k).insertText('X');
        } else {
          const [a, b] = edit.slice(8, -1).split(',').map(Number);
          $range(line, a, b).removeText();
        }
        $setSelection(null);
      });
      await t.sync();
      expect({a: text(t.a), b: text(t.b), wrote}).toEqual({
        a: expected,
        b: expected,
        wrote: {deleted: '', inserted: ''},
      });
    });
  }
});
