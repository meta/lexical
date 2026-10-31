/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// The value an undo brings back covers exactly what it covered before, or,
// where its author undid it, nothing (whether the collaborator's undo brings
// back a value its author undid is undecided, #9623); it never covers more:
// a collaborator removes a value, its author undoes it (and may write the
// same key later), a third client may delete text around the value's end,
// and the collaborator then undoes the removal. On main, with garbage
// collection on, the restored value runs on past its end (#9623), and with
// many comment ids or a concurrent undo of the end's change too (#9620):
// those cells are pinned as test.fails until the fix lands.
import {$toggleLink, LinkNode} from '@lexical/link';
import {$addMarkID, $getNodeMarkIDs, $removeMarkID} from '@lexical/mark';
import {$patchStyleText} from '@lexical/selection';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $isTextNode,
  $setState,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {
  $block,
  $selectIn,
  freshReader,
  type Peer,
  type Setup,
  setup,
} from '../../utils/harness';
import {markState, prepareMarkState} from '../../utils/sizeOps';

/**
 * The cells that fail (#9623), pinned until the fix lands. The concurrent
 * cells failed while a delete collapsed the run it left (it dropped the end
 * the restore relied on); a delete now keeps every format item it leaves
 * (D86).
 */
function failsOnMain(name: string): boolean {
  return name.includes('gc=true') && !name.includes('author keeps');
}
function testOnMain(name: string, fn: () => Promise<void>) {
  (failsOnMain(name) ? test.fails : test)(name, fn);
}

const STATE = markState('review9633');
const TEXT = 'abcd Kilo bb cc Delta end';
type Kind =
  | 'comment'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'color'
  | 'state'
  | 'link';
function $give(kind: Kind, start: number, end: number, on: boolean, count = 1) {
  const s = $selectIn([0], start, end);
  if (kind === 'comment') {
    for (let i = 0; i < count; i++) {
      if (on) {
        $addMarkID(`c${i}`, s);
      } else {
        $removeMarkID(`c${i}`, s);
      }
    }
  } else if (kind === 'color') $patchStyleText(s, {color: on ? 'red' : null});
  else if (kind === 'state') {
    for (const n of s.extract()) if ($isTextNode(n)) $setState(n, STATE, on);
  } else if (kind === 'link') $toggleLink(on ? 'https://a.test' : null);
  else s.formatText(kind, on ? {bold: 1, italic: 2, underline: 8}[kind] : 0);
}
function chars(peer: Peer, kind: Kind): [string, boolean][][] {
  return peer.read(() =>
    $getRoot()
      .getChildren()
      .map(block =>
        (block as ElementNode).getAllTextNodes().flatMap((n: TextNode) => {
          const on =
            kind === 'comment'
              ? $getNodeMarkIDs(n).includes('c0')
              : kind === 'color'
                ? n.getStyle().includes('red')
                : kind === 'state'
                  ? $getState(n, STATE)
                  : kind === 'link'
                    ? n.getParents().some(parent => parent instanceof LinkNode)
                    : n.hasFormat(kind);
          return [...n.getTextContent()].map((c): [string, boolean] => [c, on]);
        }),
      ),
  );
}
async function check(
  t: Setup,
  kind: Kind,
  // The first line and the tail with `^` where the value is, or several
  // such outcomes any of which is right.
  expected: string[] | string[][],
  label: string,
  expectedText = [TEXT, 'untouched tail'],
) {
  const got = chars(t.a, kind);
  for (const p of t.peers) {
    expect(p.doc.store.pendingStructs, label + ' pending structs').toBe(null);
    expect(p.doc.store.pendingDs, label + ' pending deletes').toBe(null);
    expect(chars(p, kind), label).toEqual(got);
  }
  expect(
    got.map(cs => cs.map(([c]) => c).join('')),
    label + ' text',
  ).toEqual(expectedText);
  const fresh = await freshReader(t.a);
  try {
    expect(chars(fresh, kind), label + ' fresh').toEqual(got);
  } finally {
    fresh.stop();
  }
  const shown = got.map(cs => cs.map(([c, on]) => (on ? '^' : c)).join(''));
  if (Array.isArray(expected[0])) {
    expect(expected as string[][], label).toContainEqual(shown);
  } else {
    expect(shown, label).toEqual(expected);
  }
}
function mask(text: string, start: number, end: number) {
  return text.slice(0, start) + '^'.repeat(end - start) + text.slice(end);
}
async function make(gc: boolean, ids: number[]) {
  const t = await setup(
    () =>
      $getRoot().append(
        $createParagraphNode().append($createTextNode(TEXT)),
        $createParagraphNode().append($createTextNode('untouched tail')),
      ),
    {ids, prepare: prepareMarkState},
  );
  for (const p of t.peers) p.doc.gc = gc;
  const sync = t.sync;
  t.sync = async () => {
    const before = t.peers.map(p => p.doc.store.getClock(p.doc.clientID));
    await sync();
    expect(
      t.peers.map(p => p.doc.store.getClock(p.doc.clientID)),
      'no writes while applying remote updates',
    ).toEqual(before);
  };
  return t;
}

for (const gc of [false, true])
  for (const ids of [
    [1, 2, 3],
    [3, 2, 1],
  ])
    for (const kind of [
      'comment',
      'bold',
      'italic',
      'underline',
      'color',
      'state',
      'link',
    ] as Kind[]) {
      for (const later of ['none', 'before-undo', 'after-undo'] as const) {
        testOnMain(
          `same client later write ${later} ${kind} gc=${gc} ids=${ids}`,
          async () => {
            const t = await make(gc, ids);
            try {
              t.b.update(() => $give(kind, 5, 9, true));
              await t.sync();
              t.a.update(() => $give(kind, 5, 9, false));
              await t.sync();
              if (later === 'before-undo') {
                t.b.update(() => $give(kind, 16, 21, true));
                await t.sync();
                t.b.undo();
                await t.sync();
              }
              t.b.undo();
              await t.sync();
              if (later === 'after-undo') {
                t.b.update(() => $give(kind, 16, 21, true));
                await t.sync();
              }
              t.a.undo();
              await t.sync();
              // The later write where it was written, and the word or not.
              const later_ = later === 'after-undo' ? mask(TEXT, 16, 21) : TEXT;
              await check(
                t,
                kind,
                [
                  [mask(later_, 5, 9), 'untouched tail'],
                  [later_, 'untouched tail'],
                ],
                'restored extent',
              );
            } finally {
              for (const p of t.peers) p.stop();
            }
          },
        );
      }
      for (const del of [
        [8, 10],
        [8, 14],
        [5, 10],
        [5, 14],
        [3, 14],
      ]) {
        testOnMain(
          `deleted noted end ${kind} gc=${gc} ids=${ids} del=${del}`,
          async () => {
            const t = await make(gc, ids);
            try {
              t.b.update(() => $give(kind, 5, 9, true));
              await t.sync();
              t.a.update(() => $give(kind, 5, 9, false));
              await t.sync();
              t.b.undo();
              await t.sync();
              t.c.update(
                () => void $selectIn([0], del[0], del[1]).removeText(),
              );
              await t.sync();
              t.a.undo();
              await t.sync();
              const remaining = TEXT.slice(0, del[0]) + TEXT.slice(del[1]);
              const marked = [...TEXT]
                .map((c, i) => (i >= 5 && i < 9 ? '^' : c))
                .join('');
              await check(
                t,
                kind,
                [
                  [
                    marked.slice(0, del[0]) + marked.slice(del[1]),
                    'untouched tail',
                  ],
                  [remaining, 'untouched tail'],
                ],
                remaining,
                [remaining, 'untouched tail'],
              );
            } finally {
              for (const p of t.peers) p.stop();
            }
          },
        );
      }
    }

for (const count of [1, 16, 64, 128, 256])
  for (const gc of [false, true])
    for (const authorKeeps of [false, true])
      testOnMain(
        `many comment keys count=${count} gc=${gc}${authorKeeps ? ' author keeps' : ''}`,
        async () => {
          const t = await make(gc, [1, 2, 3]);
          try {
            t.b.update(() => $give('comment', 5, 9, true, count));
            await t.sync();
            t.a.update(() => $give('comment', 5, 9, false, count));
            await t.sync();
            if (!authorKeeps) {
              t.b.undo();
              await t.sync();
            }
            t.a.undo();
            await t.sync();
            await check(
              t,
              'comment',
              authorKeeps
                ? [mask(TEXT, 5, 9), 'untouched tail']
                : [
                    [mask(TEXT, 5, 9), 'untouched tail'],
                    [TEXT, 'untouched tail'],
                  ],
              'cardinality',
            );
            // Every comment id comes back (where the author undid them, every
            // one or none), never only some.
            const restored = t.a.read(() =>
              $block([0])
                .getAllTextNodes()
                .filter(n => n.getTextContent().includes('Kilo'))
                .map(n => [...$getNodeMarkIDs(n)].sort()),
            );
            const every = [
              Array.from({length: count}, (_, i) => `c${i}`).sort(),
            ];
            if (authorKeeps) {
              expect(restored, 'every comment id').toEqual(every);
            } else {
              expect([every, [[]]], 'every comment id or none').toContainEqual(
                restored,
              );
            }
            // Every id on exactly the word's characters (or none), and on no
            // other character of any line.
            t.a.read(() => {
              const onWord = restored[0];
              $getRoot()
                .getChildren()
                .forEach((block, line) => {
                  let offset = 0;
                  for (const n of (block as ElementNode).getAllTextNodes()) {
                    const ids = [...$getNodeMarkIDs(n)].sort();
                    for (let k = 0; k < n.getTextContentSize(); k++) {
                      expect(ids, `ids on line ${line} at ${offset}`).toEqual(
                        line === 0 && offset >= 5 && offset < 9 ? onWord : [],
                      );
                      offset++;
                    }
                  }
                });
            });
            for (const p of t.peers)
              expect(p.doc.store.pendingStructs).toBe(null);
          } finally {
            for (const p of t.peers) p.stop();
          }
        },
      );

for (const count of [1, 16, 64, 128, 256])
  for (const ids of [
    [1, 2],
    [2, 1],
  ])
    testOnMain(
      `concurrent empty restore count=${count} ids=${ids}`,
      async () => {
        const t = await make(false, ids);
        try {
          t.a.update(() => void $addMarkID('keep', $selectIn([0], 5, 9)));
          t.b.update(() => {
            for (let i = 0; i < count; i++)
              $addMarkID(`c${i}`, $selectIn([0], 0, 3));
          });
          t.b.update(() => {
            const [, tail] = (
              $block([0]).getAllTextNodes()[0] as TextNode
            ).splitText(2);
            tail.insertBefore($createTextNode('XY'));
          });
          await t.sync();
          t.offline();
          t.a.update(() => void $selectIn([0], 2, 5).removeText());
          t.a.update(() => void $selectIn([0], 2, 7).removeText());
          t.a.undo();
          t.b.undo();
          t.b.undo();
          await t.sync();
          const remaining = 'abd Kilo bb cc Delta end';
          await check(
            t,
            'comment',
            [remaining, 'untouched tail'],
            'no undone comments',
            [remaining, 'untouched tail'],
          );
        } finally {
          for (const p of t.peers) p.stop();
        }
      },
    );
