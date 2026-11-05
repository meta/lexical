/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Content the editor does not show, moved by a local commit: a
// collaborator's insert into the line being composed (held back until the
// composition ends, see Hidden), or into a line of an update that has not
// read it yet (see Unread). The commit moves what holds it: the list item
// (in its list, to another list, nested), a block node holding the line, or
// a line holding the inline container composed in. A move is a delete and a
// write of the editor's view, which lacks that content: text in a line stayed
// at the old place (and showed in the line after it), and content in a
// shared node (an inline container, a block node) was deleted with it, on
// every client. A write now keeps the items of what holds it, and writes the
// units it passed again; a move to another container is not written and is
// read again.

import type {ListNode} from '@lexical/list';

import {$createListItemNode, $createListNode} from '@lexical/list';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getEditor,
  $getRoot,
  $hasUpdateTag,
  $setCompositionKey,
  $setSelection,
  COLLABORATION_TAG,
  ElementNode,
  type LexicalEditor,
  type LexicalNode,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $createBoxNode,
  $createEquation,
  expectConverged,
  freshReader,
  NODES,
  type Peer,
  setup,
} from '../../utils/harness';

/** An inline element stored as an inline container (its own shared node). */
class SpanNode extends ElementNode {
  $config() {
    return this.config('test_composed_span', {
      children: 'inline',
      extends: ElementNode,
    });
  }
  isInline(): boolean {
    return true;
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): boolean {
    return false;
  }
}

/** The app's reaction each editor runs once in a remote change's read. */
const reactions = new WeakMap<LexicalEditor, () => void>();

/**
 * Text whose selection transform runs an app's reaction (see reactions) in
 * the update of a remote change's read (see YBinding#$writeReadEdits).
 */
class HookNode extends TextNode {
  $config() {
    return this.config('test_composed_hook', {extends: TextNode});
  }
  selectionTransform() {
    const editor = $getEditor();
    const reaction = reactions.get(editor);
    if (reaction !== undefined && $hasUpdateTag(COLLABORATION_TAG)) {
      reactions.delete(editor);
      reaction();
    }
  }
}

/** The warnings of refused moves of held content (see $movesHeld). */
const refusals = (peer: Peer) =>
  peer.warnings.filter(w => w.includes('moves the line being composed'));

const IDS = [
  [1, 2, 3],
  [3, 2, 1],
];
const GC = [false, true];

const $abc = (): TextNode =>
  $getRoot()
    .getAllTextNodes()
    .find(n => n.getTextContent().includes('abc'))!;

const $text = (text: string) => $createTextNode(text);

const $list = (type: 'bullet' | 'number', ...items: LexicalNode[][]) =>
  $createListNode(type).append(
    ...items.map(children => $createListItemNode().append(...children)),
  );

/** Where the editor shows its root's first list's first item. */
const $firstItem = () =>
  ($getRoot().getFirstChildOrThrow() as ListNode).getFirstChildOrThrow();

const MOVES = {
  'moved down its list': () =>
    ($getRoot().getFirstChildOrThrow() as ListNode).append($firstItem()),
  'moved to another list': () =>
    ($getRoot().getLastChildOrThrow() as ListNode).append($firstItem()),
  nested: () =>
    ($getRoot().getFirstChildOrThrow() as ListNode).append(
      $createListItemNode().append(
        $createListNode('bullet').append($firstItem()),
      ),
    ),
};

/** What the move leaves, around the moved item's content. */
const MOVED = {
  'moved down its list': (item: string) =>
    `list[bullet](listitem("tail") listitem(${item})) / paragraph("sep") / list[number](listitem("other"))`,
  'moved to another list': (item: string) =>
    `list[bullet](listitem("tail")) / paragraph("sep") / list[number](listitem("other") listitem(${item}))`,
  nested: (item: string) =>
    `list[bullet](listitem("tail") listitem(list[bullet](listitem(${item})))) / paragraph("sep") / list[number](listitem("other"))`,
};

type Remote = 'text' | 'formatted text' | 'inline node';

/** B's change to `abc`, at 1: R typed (B bolds the line too), or a node. */
function $remote(remote: Remote) {
  const node = $abc();
  if (remote === 'inline node') {
    node.splitText(1)[0].insertAfter($createEquation('E'));
  } else {
    if (remote === 'formatted text') {
      node.setFormat('bold');
    }
    node.spliceText(1, 0, 'R');
  }
  $setSelection(null);
}

const SHOWN: Record<Remote, string> = {
  'formatted text': '"aRbc"{1}',
  'inline node': '"a" eq[E] "bc"',
  text: '"aRbc"',
};

/**
 * A composes in `abc` (caret at 1), B changes it, A's commit `$move` runs
 * while the change is held back, then the composition ends. Returns what a
 * fresh reader of A's document shows right after the move.
 */
async function composeAndMove(
  t: {a: Peer; b: Peer; sync: () => Promise<void>},
  remote: Remote,
  $move: () => void,
): Promise<string> {
  const {a, b} = t;
  a.update(() => {
    const node = $abc();
    node.select(1, 1);
    $setCompositionKey(node.getKey());
  });
  b.update(() => $remote(remote));
  await t.sync();
  const held = (a.binding as unknown as {state: {hidden: unknown}}).state
    .hidden;
  expect(held).not.toBeNull();
  a.update($move);
  await t.sync();
  const during = await freshReader(a);
  const stored = during.describe();
  during.stop();
  a.update(() => $setCompositionKey(null));
  await t.sync();
  return stored;
}

describe('held back while composing, the list item holding it moved', () => {
  for (const gc of GC) {
    for (const ids of IDS) {
      for (const [name, $move] of Object.entries(MOVES)) {
        for (const remote of [
          'text',
          'formatted text',
          'inline node',
        ] as const) {
          test(`${name}, ${remote} (gc ${gc}, ids ${ids})`, async () => {
            const t = await setup(
              () =>
                $getRoot().append(
                  $list('bullet', [$text('abc')], [$text('tail')]),
                  $createParagraphNode().append($text('sep')),
                  $list('number', [$text('other')]),
                ),
              {gc, ids},
            );
            const stored = await composeAndMove(t, remote, $move);
            const expected = MOVED[name as keyof typeof MOVED](SHOWN[remote]);
            expect(stored).toBe(expected);
            expect(refusals(t.a)).toEqual([]);
            await expectConverged(t.peers, expected);
          });
        }
      }
    }
  }
});

describe('held back in an inline container, the line holding it moved', () => {
  for (const gc of GC) {
    for (const ids of IDS) {
      for (const [name, $move] of Object.entries(MOVES)) {
        for (const remote of ['text', 'formatted text'] as const) {
          test(`${name}, ${remote} (gc ${gc}, ids ${ids})`, async () => {
            const t = await setup(
              () =>
                $getRoot().append(
                  $list(
                    'bullet',
                    [$create(SpanNode).append($text('abc'))],
                    [$text('tail')],
                  ),
                  $createParagraphNode().append($text('sep')),
                  $list('number', [$text('other')]),
                ),
              {gc, ids, nodes: [...NODES, SpanNode]},
            );
            await composeAndMove(t, remote, $move);
            await expectConverged(
              t.peers,
              MOVED[name as keyof typeof MOVED](
                `test_composed_span(${SHOWN[remote]})`,
              ),
            );
          });
        }
      }
    }
  }
});

describe('held back in a block node, the block node moved in its container', () => {
  for (const gc of GC) {
    for (const ids of IDS) {
      test(`moved down (gc ${gc}, ids ${ids})`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createBoxNode().append(
                $createParagraphNode().append($text('abc')),
              ),
              $createParagraphNode().append($text('tail')),
            ),
          {gc, ids},
        );
        await composeAndMove(t, 'formatted text', () =>
          $getRoot().append($getRoot().getFirstChildOrThrow()),
        );
        await expectConverged(
          t.peers,
          'paragraph("tail") / test_box(paragraph("aRbc"{1}))',
        );
      });
    }
  }
});

// A move to another container deletes what it moves and writes it again in
// the other container: the commit is not written, and the editor reads the
// document again (the move is undone, nothing held is lost).
describe('held back, moved to another container: not written', () => {
  const cases: {
    name: string;
    $init: () => void;
    $move: () => void;
    expected: string;
  }[] = [
    {
      $init: () =>
        $getRoot().append(
          $createBoxNode().append($createParagraphNode().append($text('abc'))),
          $createBoxNode().append($createParagraphNode().append($text('tail'))),
        ),
      $move: () =>
        ($getRoot().getLastChildOrThrow() as ElementNode).append(
          $getRoot().getFirstChildOrThrow(),
        ),
      expected: 'test_box(paragraph("aRbc"{1})) / test_box(paragraph("tail"))',
      name: 'a block node holding the line, into another block node',
    },
    {
      $init: () =>
        $getRoot().append(
          $createParagraphNode().append($text('abc')),
          $createParagraphNode().append($text('mid')),
          $createBoxNode().append($createParagraphNode().append($text('tail'))),
        ),
      $move: () =>
        ($getRoot().getLastChildOrThrow() as ElementNode).append(
          $abc().getParentOrThrow(),
        ),
      expected:
        'paragraph("aRbc"{1}) / paragraph("mid") / test_box(paragraph("tail"))',
      name: 'the line, into a block node',
    },
    {
      $init: () =>
        $getRoot().append(
          $createBoxNode().append(
            $createParagraphNode().append($text('abc')),
            $createParagraphNode().append($text('in')),
          ),
          $createParagraphNode().append($text('tail')),
        ),
      $move: () => $getRoot().append($abc().getParentOrThrow()),
      expected:
        'test_box(paragraph("aRbc"{1}) paragraph("in")) / paragraph("tail")',
      name: 'the line, out of a block node',
    },
    {
      $init: () =>
        $getRoot().append(
          $createParagraphNode().append($create(SpanNode).append($text('abc'))),
          $createParagraphNode().append($text('tail')),
        ),
      $move: () =>
        ($getRoot().getLastChildOrThrow() as ElementNode).append(
          $abc().getParentOrThrow(),
        ),
      expected: 'paragraph(test_composed_span("aRbc"{1})) / paragraph("tail")',
      name: 'the inline container composed in, to another line',
    },
  ];
  for (const gc of GC) {
    for (const ids of IDS) {
      for (const {name, $init, $move, expected} of cases) {
        test(`${name} (gc ${gc}, ids ${ids})`, async () => {
          const t = await setup($init, {
            gc,
            ids,
            nodes: [...NODES, SpanNode],
          });
          const stored = await composeAndMove(t, 'formatted text', $move);
          expect(stored).toBe(expected);
          expect(refusals(t.a)).toHaveLength(1);
          await expectConverged(t.peers, expected);
        });
      }
    }
  }
});

// #9784: a change applied during a local update is read after it; the
// update was written on the document without it (see Unread).
describe('inserted by a change not read yet, the list item holding it moved', () => {
  for (const gc of GC) {
    for (const ids of IDS) {
      for (const span of [false, true]) {
        test(`${span ? 'in an inline container' : 'in the line'} (gc ${gc}, ids ${ids})`, async () => {
          const t = await setup(
            () =>
              $getRoot().append(
                $list(
                  'bullet',
                  [
                    span
                      ? $create(SpanNode).append($text('abc'))
                      : $text('abc'),
                  ],
                  [$text('tail')],
                ),
                $createParagraphNode().append($text('sep')),
                $list('number', [$text('other')]),
              ),
            {gc, ids, nodes: [...NODES, SpanNode]},
          );
          const {a, b} = t;
          t.offline();
          b.update(() => $remote('formatted text'));
          const delta = Y.encodeStateAsUpdate(
            b.doc,
            Y.encodeStateVector(a.doc),
          );
          a.update(() => {
            Y.applyUpdate(a.doc, delta, 'provider');
            MOVES['moved to another list']();
          });
          await t.sync();
          await expectConverged(
            t.peers,
            MOVED['moved to another list'](
              span ? 'test_composed_span("aRbc"{1})' : '"aRbc"{1}',
            ),
          );
        });
      }
    }
  }
});

// #9788: an app's edit in the update of a remote change's read (a selection
// transform) is written as a local commit is, over the state the read made:
// the same keep and the same refusal.
describe('held back while composing, moved by an app in a remote read', () => {
  const REFUSED = 'into a block node';
  for (const gc of GC) {
    for (const ids of IDS) {
      for (const name of [...Object.keys(MOVES), REFUSED]) {
        test(`${name} (gc ${gc}, ids ${ids})`, async () => {
          const t = await setup(
            () =>
              $getRoot().append(
                $list(
                  'bullet',
                  [$create(HookNode).setTextContent('abc')],
                  [$text('tail')],
                ),
                $createParagraphNode().append($text('sep')),
                $list('number', [$text('other')]),
                ...(name === REFUSED
                  ? [
                      $createBoxNode().append(
                        $createParagraphNode().append($text('in box')),
                      ),
                    ]
                  : []),
              ),
            {gc, ids, nodes: [...NODES, HookNode]},
          );
          const {a, b, c} = t;
          a.update(() => {
            const node = $abc();
            node.select(1, 1);
            $setCompositionKey(node.getKey());
          });
          b.update(() => $remote('formatted text'));
          await t.sync();
          const held = (a.binding as unknown as {state: {hidden: unknown}})
            .state.hidden;
          expect(held).not.toBeNull();
          reactions.set(a.editor, () => {
            if (name === REFUSED) {
              ($getRoot().getLastChildOrThrow() as ElementNode).append(
                $firstItem(),
              );
            } else {
              MOVES[name as keyof typeof MOVES]();
            }
          });
          // C's change is read in an update in which the app moves the item.
          c.update(() => {
            $getRoot()
              .getAllTextNodes()
              .find(n => n.getTextContent() === 'sep')!
              .spliceText(3, 0, '!');
            $setSelection(null);
          });
          await t.sync();
          expect(reactions.has(a.editor)).toBe(false);
          const during = await freshReader(a);
          expect(during.describe()).toContain('aRbc');
          during.stop();
          expect(refusals(a)).toHaveLength(name === REFUSED ? 1 : 0);
          a.update(() => $setCompositionKey(null));
          await t.sync();
          const expected =
            name === REFUSED
              ? 'list[bullet](listitem("aRbc"{1}) listitem("tail")) / paragraph("sep!") / list[number](listitem("other")) / test_box(paragraph("in box"))'
              : MOVED[name as keyof typeof MOVED]('"aRbc"{1}').replace(
                  'paragraph("sep")',
                  'paragraph("sep!")',
                );
          await expectConverged(t.peers, expected);
        });
      }
    }
  }
});
