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

import type {ListItemNode, ListNode} from '@lexical/list';

import {$createListItemNode, $createListNode} from '@lexical/list';
import {$createHeadingNode} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getEditor,
  $getRoot,
  $getSelection,
  $hasUpdateTag,
  $setCompositionKey,
  $setSelection,
  $setSlot,
  COLLABORATION_TAG,
  ElementNode,
  type LexicalEditor,
  type LexicalNode,
  ParagraphNode,
  type RangeSelection,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $createBoxNode,
  $createEquation,
  ColContainerNode,
  ColContentNode,
  ColTitleNode,
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

// An inline container composed in, unwrapped: its text moves into the line
// and Lexical merges it into the text before it. That adds no character
// (the merged text is the old texts, in order), so the commit is refused
// like any other move of held content out of its node.
describe('held back in an inline container, unwrapped into the text before it', () => {
  for (const gc of GC) {
    test(`gc ${gc}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $text('x'),
              $create(SpanNode).append($text('abc')),
            ),
            $createParagraphNode().append($text('tail')),
          ),
        {gc, ids: [1, 2, 3], nodes: [...NODES, SpanNode]},
      );
      await composeAndMove(t, 'text', () => {
        const span = $abc().getParentOrThrow();
        for (const child of span.getChildren()) {
          span.insertBefore(child);
        }
        span.remove();
      });
      expect(refusals(t.a)).toHaveLength(1);
      const shown = t.a.describe();
      expect(shown).toContain('aRbc');
      expect(shown).toBe((await freshReader(t.a)).describe());
      await expectConverged(t.peers);
    });
  }
});

// The same moves in a commit that also types: what is typed is never
// dropped, so the commit is written (as it would be without the hold: the
// held text is lost where the write cannot keep it), with no warning.
describe('held back, moved to another container with typing: written', () => {
  for (const gc of GC) {
    test(`the line, into a block node (gc ${gc})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($text('abc')),
            $createParagraphNode().append($text('mid')),
            $createBoxNode().append(
              $createParagraphNode().append($text('tail')),
            ),
          ),
        {gc, ids: [1, 2, 3]},
      );
      await composeAndMove(t, 'text', () => {
        const text = $abc();
        text.spliceText(1, 0, 'x');
        ($getRoot().getLastChildOrThrow() as ElementNode).append(
          text.getParentOrThrow(),
        );
      });
      expect(refusals(t.a)).toEqual([]);
      const shown = t.a.describe();
      expect(shown).toContain('axbc');
      expect(shown).toBe((await freshReader(t.a)).describe());
      await expectConverged(t.peers);
    });
  }
});

// The editor can still show a character a change not read yet deleted
// (D108): typed again in the same commit, it looks like one the text had, but
// is typed. Such a commit is written, with what was typed.
describe('held back, moved to another container retyping a character a change not read yet deleted', () => {
  for (const gc of GC) {
    test(`gc ${gc}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($text('abc')),
            $createParagraphNode().append($text('mid')),
            $createBoxNode().append(
              $createParagraphNode().append($text('tail')),
            ),
          ),
        {gc, ids: [1, 2, 3]},
      );
      const {a, b} = t;
      a.update(() => {
        const node = $abc();
        node.select(1, 1);
        $setCompositionKey(node.getKey());
      });
      b.update(() => $remote('text'));
      await t.sync();
      expect(
        (a.binding as unknown as {state: {hidden: unknown}}).state.hidden,
      ).not.toBeNull();
      t.offline();
      const seen = Y.encodeStateVector(b.doc);
      b.update(() => {
        $getRoot()
          .getAllTextNodes()
          .find(n => n.getTextContent() === 'aRbc')!
          .spliceText(2, 1, '');
        $setSelection(null);
      });
      const delta = Y.encodeStateAsUpdate(b.doc, seen);
      a.update(() => {
        Y.applyUpdate(a.doc, delta, 'provider');
        // The composition replaces the whole text with what was typed.
        const text = $abc();
        text.setTextContent('b');
        ($getRoot().getLastChildOrThrow() as ElementNode).append(
          text.getParentOrThrow(),
        );
      });
      await t.sync();
      a.update(() => $setCompositionKey(null));
      await t.sync();
      expect(refusals(t.a)).toEqual([]);
      for (const p of t.peers) {
        expect(
          p.read(() => $getRoot().getTextContent()).replace(/\n+/g, '|'),
        ).toContain('|b');
      }
      expect(a.describe()).toBe((await freshReader(a)).describe());
      await expectConverged(t.peers);
    });
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

// The node holding the text being composed replaced by a new one that takes
// its children: a line's block type changed keeps the held content (a line's
// content is its container's); an inline container's children moved into a
// new one would delete the held content with the old one, so that is not
// written.
describe('held back, the node holding the composed text replaced', () => {
  for (const gc of GC) {
    for (const holder of [
      'a line made a heading',
      'an inline container',
    ] as const) {
      test(`${holder} (gc ${gc})`, async () => {
        const span = holder === 'an inline container';
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append(
                span ? $create(SpanNode).append($text('abc')) : $text('abc'),
              ),
              $createParagraphNode().append($text('tail')),
            ),
          {gc, ids: [1, 2, 3], nodes: [...NODES, SpanNode]},
        );
        await composeAndMove(t, 'text', () => {
          const text = $abc();
          const old = text.getParentOrThrow();
          const next = span ? $create(SpanNode) : $createHeadingNode('h1');
          old.insertBefore(next);
          next.append(...old.getChildren());
          old.remove();
        });
        const shown = t.a.describe();
        expect(shown).toBe((await freshReader(t.a)).describe());
        expect(shown).toContain('aRbc');
        expect(refusals(t.a)).toHaveLength(span ? 1 : 0);
        await expectConverged(t.peers);
      });
    }
  }
});

/** A paragraph with a named slot next to its children (a card's title). */
class TitledNode extends ParagraphNode {
  $config() {
    return this.config('test_composed_titled', {
      extends: ParagraphNode,
      slots: ['title'],
    });
  }
}

// Composing in a line in a named slot: a slot's value has no parent, its host
// is found through the slot. Nothing moves to another container here.
describe('held back in a slot, an edit that moves nothing out', () => {
  for (const gc of GC) {
    for (const edit of [
      'a keystroke in the composed text',
      'an edit elsewhere',
      'the host moved in its container',
    ] as const) {
      test(`${edit} (gc ${gc})`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $setSlot(
                $create(TitledNode),
                'title',
                $createParagraphNode().append($text('abc')),
              ),
              $createParagraphNode().append($text('other')),
            ),
          {gc, ids: [1, 2, 3], nodes: [...NODES, TitledNode]},
        );
        await composeAndMove(t, 'text', () => {
          if (edit === 'a keystroke in the composed text') {
            const text = $abc();
            text.spliceText(1, 0, 'x');
          } else if (edit === 'an edit elsewhere') {
            const other = $getRoot()
              .getAllTextNodes()
              .find(n => n.getTextContent() === 'other')!;
            other.setTextContent('other OWN');
          } else {
            $getRoot().append($getRoot().getFirstChildOrThrow());
          }
        });
        expect(refusals(t.a)).toEqual([]);
        const shown = t.a.describe();
        expect(shown).toBe((await freshReader(t.a)).describe());
        // Slot text included.
        const $all = () =>
          $getRoot()
            .getAllTextNodes()
            .map(n => n.getTextContent())
            .join('|');
        expect(t.a.read($all)).toContain(
          edit === 'a keystroke in the composed text' ? 'axRbc' : 'aRbc',
        );
        for (const p of t.peers) {
          expect(p.read($all)).toBe(t.a.read($all));
        }
        if (edit === 'an edit elsewhere') {
          expect(shown).toContain('other OWN');
        }
        if (edit === 'the host moved in its container') {
          expect(shown).toMatch(/paragraph\("other"\).*test_composed_titled/);
        }
        await expectConverged(t.peers);
      });
    }
  }
});

// Two lines in one container that each hold a change not read yet, whose
// order a commit changes: a write keeps only one of them, and a refusal
// would read the change twice, so the commit is written as without the
// change (as `main` writes it, see D112); one line alone is kept, as above.
describe('inserted by a change not read yet in two lines, reordered', () => {
  for (const gc of GC) {
    for (const shape of ['paragraphs', 'list', 'inline containers'] as const) {
      for (const lines of [1, 2]) {
        test(`${shape}, ${lines} line(s) (gc ${gc})`, async () => {
          const $line = (text: string) =>
            shape === 'paragraphs'
              ? $createParagraphNode().append($text(text))
              : $createListItemNode().append(
                  shape === 'inline containers'
                    ? $create(SpanNode).append($text(text))
                    : $text(text),
                );
          const t = await setup(
            () => {
              const all = [$line('aa'), $line('bb'), $line('tail')];
              if (shape === 'paragraphs') {
                $getRoot().append(...all);
              } else {
                $getRoot().append($createListNode('number').append(...all));
              }
            },
            {gc, ids: [1, 2, 3], nodes: [...NODES, SpanNode]},
          );
          const {a, b} = t;
          t.offline();
          const seen = Y.encodeStateVector(b.doc);
          b.update(() => {
            const texts = $getRoot().getAllTextNodes();
            texts[0].spliceText(1, 0, 'X');
            if (lines === 2) {
              texts[1].spliceText(1, 0, 'Y');
            }
            $setSelection(null);
          });
          const delta = Y.encodeStateAsUpdate(b.doc, seen);
          a.update(() => {
            Y.applyUpdate(a.doc, delta, 'provider');
            const container =
              shape === 'paragraphs'
                ? $getRoot()
                : ($getRoot().getFirstChildOrThrow() as ListNode);
            // The first line to the end.
            container.append(container.getFirstChildOrThrow());
          });
          await t.sync();
          const fresh = await freshReader(a);
          const text = a.read(() => $getRoot().getTextContent());
          expect(text).toBe(fresh.read(() => $getRoot().getTextContent()));
          expect(a.warnings.filter(w => w.includes('composing'))).toEqual([]);
          if (lines === 1) {
            // Kept: the moved line holds the change.
            expect(text.replace(/\n+/g, '|')).toBe('bb|tail|aXa');
          }
          await expectConverged(t.peers);
        });
      }
    }
  }
});

// The same, where what is not read yet is in the hosts' named slots.
describe('inserted by a change not read yet in two slots, their hosts reordered', () => {
  for (const gc of GC) {
    test(`gc ${gc}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $setSlot(
              $create(TitledNode),
              'title',
              $createParagraphNode().append($text('aa')),
            ),
            $setSlot(
              $create(TitledNode),
              'title',
              $createParagraphNode().append($text('bb')),
            ),
            $createParagraphNode().append($text('tail')),
          ),
        {gc, ids: [1, 2, 3], nodes: [...NODES, TitledNode]},
      );
      const {a, b} = t;
      t.offline();
      const seen = Y.encodeStateVector(b.doc);
      b.update(() => {
        const texts = $getRoot().getAllTextNodes();
        texts.find(n => n.getTextContent() === 'aa')!.spliceText(1, 0, 'X');
        texts.find(n => n.getTextContent() === 'bb')!.spliceText(1, 0, 'Y');
        $setSelection(null);
      });
      const delta = Y.encodeStateAsUpdate(b.doc, seen);
      a.update(() => {
        Y.applyUpdate(a.doc, delta, 'provider');
        $getRoot()
          .getFirstChildOrThrow()
          .insertBefore($getRoot().getChildAtIndex(1)!);
      });
      await t.sync();
      const $all = () =>
        $getRoot()
          .getAllTextNodes()
          .map(n => n.getTextContent())
          .join('|');
      // Written as without the change (see above): no refusal.
      expect(a.warnings.filter(w => w.includes('composing'))).toEqual([]);
      for (const p of t.peers) {
        expect(p.read($all)).toBe(a.read($all));
      }
      expect(a.describe()).toBe((await freshReader(a)).describe());
    });
  }
});

// Composing in a block node that holds its text itself (a collapsible's
// title): the same node is the inline container one level down and the unit
// holding it one level up. Nothing moves to another container here.
describe('held back in a collapsible title, an edit that moves nothing out', () => {
  for (const gc of GC) {
    for (const edit of [
      'a keystroke in the composed text',
      'the collapsible moved in its container',
    ] as const) {
      test(`${edit} (gc ${gc})`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $create(ColContainerNode).append(
                $create(ColTitleNode).append($text('abc')),
                $create(ColContentNode).append(
                  $createParagraphNode().append($text('body')),
                ),
              ),
              $createParagraphNode().append($text('other')),
            ),
          {gc, ids: [1, 2, 3]},
        );
        await composeAndMove(t, 'text', () => {
          if (edit === 'a keystroke in the composed text') {
            $abc().spliceText(1, 0, 'x');
          } else {
            $getRoot().append($getRoot().getFirstChildOrThrow());
          }
        });
        expect(refusals(t.a)).toEqual([]);
        const shown = t.a.describe();
        expect(shown).toBe((await freshReader(t.a)).describe());
        expect(shown).toContain(
          edit === 'a keystroke in the composed text' ? '"axRbc"' : '"aRbc"',
        );
        if (edit === 'the collapsible moved in its container') {
          expect(shown).toMatch(/^paragraph\("other"\) \/ test_col/);
        }
        await expectConverged(t.peers);
      });
    }
  }
});

// A paragraph a change not read yet inserts holds content the editor does not
// show, but is no line the document had: a line moved past it is stored.
describe('a paragraph inserted by a change not read yet, another line moved', () => {
  for (const gc of GC) {
    test(`gc ${gc}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            ...['aa', 'bb', 'cc'].map(text =>
              $createParagraphNode().append($text(text)),
            ),
          ),
        {gc, ids: [1, 2, 3]},
      );
      const {a, b} = t;
      t.offline();
      const seen = Y.encodeStateVector(b.doc);
      b.update(() => {
        const [, bb] = $getRoot().getChildren();
        bb.insertBefore($createParagraphNode().append($text('new')));
        $getRoot()
          .getAllTextNodes()
          .find(n => n.getTextContent() === 'cc')!
          .spliceText(1, 0, 'Y');
        $setSelection(null);
      });
      const delta = Y.encodeStateAsUpdate(b.doc, seen);
      a.update(() => {
        Y.applyUpdate(a.doc, delta, 'provider');
        $getRoot().append($getRoot().getChildAtIndex(1)!);
      });
      await t.sync();
      expect(a.warnings.filter(w => w.includes('reorders lines'))).toEqual([]);
      const text = a.read(() => $getRoot().getTextContent());
      expect(text.replace(/\n+/g, '|')).toBe('aa|new|cYc|bb');
      expect(a.describe()).toBe((await freshReader(a)).describe());
      await expectConverged(t.peers);
    });
  }
});

// The same change also types into a line the document had (in an inline
// container or not): that line keeps its change, and the paragraph inserted
// after it is not counted as that line's, nor the next one's.
describe('a paragraph and text inserted by a change not read yet, a line moved past them', () => {
  for (const gc of GC) {
    for (const span of [false, true]) {
      test(`${span ? 'in an inline container' : 'in the line'} (gc ${gc})`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append(
                span ? $create(SpanNode).append($text('aa')) : $text('aa'),
              ),
              $createParagraphNode().append($text('bb')),
              $createParagraphNode().append($text('tail')),
            ),
          {gc, ids: [1, 2, 3], nodes: [...NODES, SpanNode]},
        );
        const {a, b} = t;
        t.offline();
        const seen = Y.encodeStateVector(b.doc);
        b.update(() => {
          const [first] = $getRoot().getChildren();
          $getRoot()
            .getAllTextNodes()
            .find(n => n.getTextContent() === 'aa')!
            .spliceText(1, 0, 'X');
          first.insertAfter($createParagraphNode().append($text('new')));
          $setSelection(null);
        });
        const delta = Y.encodeStateAsUpdate(b.doc, seen);
        a.update(() => {
          Y.applyUpdate(a.doc, delta, 'provider');
          $getRoot()
            .getFirstChildOrThrow()
            .insertBefore($getRoot().getChildAtIndex(1)!);
        });
        await t.sync();
        expect(a.warnings.filter(w => w.includes('reorders lines'))).toEqual(
          [],
        );
        const text = a.read(() => $getRoot().getTextContent());
        expect(text.replace(/\n+/g, '|')).toBe('bb|aXa|new|tail');
        expect(a.describe()).toBe((await freshReader(a)).describe());
        await expectConverged(t.peers);
      });
    }
  }
});

// A change not read yet that splits a line the document had: the line still
// holds it (the editor shows it whole) and is kept when it moves.
describe('a line a change not read yet types into and splits, moved', () => {
  for (const gc of GC) {
    test(`gc ${gc}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            ...['aabb', 'mid', 'tail'].map(text =>
              $createParagraphNode().append($text(text)),
            ),
          ),
        {gc, ids: [1, 2, 3]},
      );
      const {a, b} = t;
      t.offline();
      const seen = Y.encodeStateVector(b.doc);
      b.update(() => {
        const text = $getRoot()
          .getAllTextNodes()
          .find(n => n.getTextContent() === 'aabb')!;
        text.spliceText(1, 0, 'X');
        text.select(3, 3);
        ($getSelection() as RangeSelection).insertParagraph();
        $setSelection(null);
      });
      const delta = Y.encodeStateAsUpdate(b.doc, seen);
      a.update(() => {
        Y.applyUpdate(a.doc, delta, 'provider');
        $getRoot().append($getRoot().getFirstChildOrThrow());
      });
      await t.sync();
      expect(a.warnings.filter(w => w.includes('composing'))).toEqual([]);
      const text = a.read(() => $getRoot().getTextContent());
      expect(text.replace(/\n+/g, '|')).toBe('mid|tail|aXa|bb');
      expect(a.describe()).toBe((await freshReader(a)).describe());
      await expectConverged(t.peers);
    });
  }
});

// A paragraph with formatted text a change not read yet appends, and one
// the update appends too: the update's paragraph is written after the whole
// of the change's, not at a format inside it.
describe('a formatted paragraph a change not read yet appends, and one the update appends', () => {
  for (const gc of GC) {
    test(`gc ${gc}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            ...['aa', 'bb'].map(text =>
              $createParagraphNode().append($text(text)),
            ),
          ),
        {gc, ids: [1, 2, 3]},
      );
      const {a, b} = t;
      t.offline();
      const seen = Y.encodeStateVector(b.doc);
      b.update(() => {
        $getRoot().append(
          $createParagraphNode().append(
            $text('[x]'),
            $text('[y]').setFormat('bold'),
            $text('[z]'),
          ),
        );
        $setSelection(null);
      });
      const delta = Y.encodeStateAsUpdate(b.doc, seen);
      a.update(() => {
        Y.applyUpdate(a.doc, delta, 'provider');
        $getRoot().append($createParagraphNode().append($text('[new]')));
      });
      await t.sync();
      const text = a.read(() => $getRoot().getTextContent());
      expect(text.replace(/\n+/g, '|')).toMatch(
        /^aa\|bb\|(\[x\]\[y\]\[z\]\|\[new\]|\[new\]\|\[x\]\[y\]\[z\])$/,
      );
      expect(a.describe()).toBe((await freshReader(a)).describe());
      await expectConverged(t.peers);
    });
  }
});

// The kept line's passed lines are written again; a paragraph the same
// change inserted between two of them is not, and ends up next to the kept
// line (a limit, see D112): nothing is lost.
describe('a paragraph a change not read yet inserts between the lines a kept line passes', () => {
  for (const gc of GC) {
    test(`gc ${gc}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            ...['aa', 'bb', 'cc', 'dd'].map(text =>
              $createParagraphNode().append($text(text)),
            ),
          ),
        {gc, ids: [1, 2, 3]},
      );
      const {a, b} = t;
      t.offline();
      const seen = Y.encodeStateVector(b.doc);
      b.update(() => {
        $getRoot()
          .getAllTextNodes()
          .find(n => n.getTextContent() === 'aa')!
          .spliceText(1, 0, 'X');
        $getRoot()
          .getChildAtIndex(2)!
          .insertAfter($createParagraphNode().append($text('new')));
        $setSelection(null);
      });
      const delta = Y.encodeStateAsUpdate(b.doc, seen);
      a.update(() => {
        Y.applyUpdate(a.doc, delta, 'provider');
        $getRoot().append($getRoot().getFirstChildOrThrow());
      });
      await t.sync();
      const text = a.read(() => $getRoot().getTextContent());
      expect(text.replace(/\n+/g, '|')).toBe('bb|cc|dd|aXa|new');
      expect(a.describe()).toBe((await freshReader(a)).describe());
      await expectConverged(t.peers);
    });
  }
});

// A paragraph a change not read yet inserts before a line it formats, that
// line moved: the lines written again go before the format, not inside it.
describe('a paragraph inserted before a line a change not read yet formats, that line moved', () => {
  for (const gc of GC) {
    test(`gc ${gc}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            ...['aa', 'bb', 'cc'].map(text =>
              $createParagraphNode().append($text(text)),
            ),
          ),
        {gc, ids: [1, 2, 3]},
      );
      const {a, b} = t;
      t.offline();
      const seen = Y.encodeStateVector(b.doc);
      b.update(() => {
        const first = $getRoot().getFirstChildOrThrow();
        first.insertBefore($createParagraphNode().append($text('new')));
        $getRoot()
          .getAllTextNodes()
          .find(n => n.getTextContent() === 'aa')!
          .setFormat('bold');
        $setSelection(null);
      });
      const delta = Y.encodeStateAsUpdate(b.doc, seen);
      a.update(() => {
        Y.applyUpdate(a.doc, delta, 'provider');
        // The editor does not show `new` yet: its first line is `aa`.
        $getRoot().append($getRoot().getFirstChildOrThrow());
      });
      await t.sync();
      const bold = a.read(() =>
        $getRoot()
          .getAllTextNodes()
          .filter(n => n.hasFormat('bold'))
          .map(n => n.getTextContent()),
      );
      expect(bold).toEqual(['aa']);
      expect(a.describe()).toBe((await freshReader(a)).describe());
      await expectConverged(t.peers);
    });
  }
});

// A change not read yet that types into a line and deletes, or changes, a
// line that line passes when it moves: keeping the line would write the
// passed line again from the editor, which still shows what the change
// deleted. Such a commit is written as without the change, keeping no unit.
describe('a change not read yet types into a line and changes a line it passes, the line moved', () => {
  const changes: {name: string; init: () => void; $change: () => void}[] = [
    {
      $change: () =>
        $getRoot()
          .getAllTextNodes()
          .find(n => n.getTextContent() === 'bbb')!
          .spliceText(0, 1, ''),
      init: () =>
        $getRoot().append(
          ...['aa', 'bbb', 'cc'].map(text =>
            $createParagraphNode().append($text(text)),
          ),
        ),
      name: 'deletes text in it',
    },
    {
      $change: () => $getRoot().getChildAtIndex(1)!.remove(),
      init: () =>
        $getRoot().append(
          ...['aa', 'bb', 'cc'].map(text =>
            $createParagraphNode().append($text(text)),
          ),
        ),
      name: 'removes it',
    },
    {
      $change: () => {
        const bb = $getRoot().getChildAtIndex(1)! as ElementNode;
        const heading = $createHeadingNode('h1');
        bb.insertBefore(heading);
        heading.append(...bb.getChildren());
        bb.remove();
      },
      init: () =>
        $getRoot().append(
          ...['aa', 'bb', 'cc'].map(text =>
            $createParagraphNode().append($text(text)),
          ),
        ),
      name: 'makes it a heading',
    },
    {
      $change: () =>
        (
          ($getRoot().getFirstChildOrThrow() as ListNode).getChildAtIndex(
            1,
          ) as ListItemNode
        ).setChecked(true),
      init: () =>
        $getRoot().append(
          $createListNode('check').append(
            ...['aa', 'bb', 'cc'].map(text =>
              $createListItemNode().append($text(text)),
            ),
          ),
        ),
      name: 'checks it',
    },
  ];
  for (const gc of GC) {
    for (const {name, init, $change} of changes) {
      for (const typing of [false, true]) {
        test(`${name}${typing ? ', the update typing' : ''} (gc ${gc})`, async () => {
          const t = await setup(init, {gc, ids: [1, 2, 3]});
          const {a, b} = t;
          t.offline();
          const seen = Y.encodeStateVector(b.doc);
          b.update(() => {
            $getRoot()
              .getAllTextNodes()
              .find(n => n.getTextContent() === 'aa')!
              .spliceText(1, 0, 'X');
            $change();
            $setSelection(null);
          });
          const delta = Y.encodeStateAsUpdate(b.doc, seen);
          a.update(() => {
            Y.applyUpdate(a.doc, delta, 'provider');
            const aa = $getRoot()
              .getAllTextNodes()
              .find(n => n.getTextContent() === 'aa')!;
            if (typing) {
              aa.spliceText(2, 0, 'T');
            }
            const line = aa.getParentOrThrow();
            line.getParentOrThrow().append(line);
          });
          await t.sync();
          const fresh = await freshReader(a);
          expect(a.describe()).toBe(fresh.describe());
          fresh.stop();
          await expectConverged(t.peers);
          // Written as without the change, with no unit kept (as `main`
          // writes it): what the change deleted or changed does not come
          // back.
          expect(a.warnings.filter(w => w.includes('composing'))).toEqual([]);
          if (typing) {
            expect(a.read(() => $getRoot().getTextContent())).toContain('T');
          }
          const text = a.read(() => $getRoot().getTextContent());
          if (name === 'deletes text in it') {
            expect(text).not.toContain('bbb');
          }
          if (name === 'removes it') {
            expect(text).not.toContain('bb');
          }
          if (name === 'makes it a heading') {
            expect(a.describe()).toContain('heading');
          }
        });
      }
    }
  }
});

// A line kept for what it holds passes a block node (a box): the block node
// would be copied whole, losing what a collaborator types in it at the same
// time, so the move is written as without the hold.
describe('held back, the line moved past a block node a collaborator edits', () => {
  for (const gc of GC) {
    test(`gc ${gc}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($text('abc')),
            $createBoxNode().append(
              $createParagraphNode().append($text('inbox')),
            ),
            $createParagraphNode().append($text('tail')),
          ),
        {gc, ids: [1, 2, 3]},
      );
      const {a, b, c} = t;
      a.update(() => {
        const node = $abc();
        node.select(1, 1);
        $setCompositionKey(node.getKey());
      });
      b.update(() => $remote('text'));
      await t.sync();
      expect(
        (a.binding as unknown as {state: {hidden: unknown}}).state.hidden,
      ).not.toBeNull();
      t.offline();
      c.update(() => {
        $getRoot()
          .getAllTextNodes()
          .find(n => n.getTextContent() === 'inbox')!
          .spliceText(2, 0, 'Z');
        $setSelection(null);
      });
      a.update(() => {
        $getRoot().append($abc().getParentOrThrow());
      });
      await t.sync();
      a.update(() => $setCompositionKey(null));
      await t.sync();
      for (const p of t.peers) {
        expect(p.read(() => $getRoot().getTextContent())).toContain('inZbox');
      }
      expect(a.describe()).toBe((await freshReader(a)).describe());
      await expectConverged(t.peers);
    });
  }
});

// A block node holding the composed line moved past another block node:
// keeping it would copy the passed block node whole, so the move is written
// as without the hold, and the held text is lost, as on `main` (a limit, see
// D112).
describe('held back in a block node moved past another block node', () => {
  for (const gc of GC) {
    test(`gc ${gc}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createBoxNode().append(
              $createParagraphNode().append($text('abc')),
            ),
            $createBoxNode().append(
              $createParagraphNode().append($text('other box')),
            ),
          ),
        {gc, ids: [1, 2, 3]},
      );
      await composeAndMove(t, 'text', () => {
        $getRoot().append($getRoot().getFirstChildOrThrow());
      });
      expect(refusals(t.a)).toEqual([]);
      expect(t.a.describe()).toBe(
        'test_box(paragraph("other box")) / test_box(paragraph("abc"))',
      );
      expect(t.a.describe()).toBe((await freshReader(t.a)).describe());
      await expectConverged(t.peers);
    });
  }
});

// An update that inserts a node that is content but not text (an inline
// equation) and moves the line to another container is not refused: the
// node would be dropped.
describe('held back, moved to another container with an inline node inserted: written', () => {
  for (const gc of GC) {
    test(`gc ${gc}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($text('abc')),
            $createBoxNode().append(
              $createParagraphNode().append($text('tail')),
            ),
          ),
        {gc, ids: [1, 2, 3]},
      );
      await composeAndMove(t, 'text', () => {
        const line = $abc().getParentOrThrow();
        line.append($createEquation('E'));
        ($getRoot().getLastChildOrThrow() as ElementNode).append(line);
      });
      expect(refusals(t.a)).toEqual([]);
      expect(t.a.describe()).toContain('eq[E]');
      expect(t.a.describe()).toBe((await freshReader(t.a)).describe());
      await expectConverged(t.peers);
    });
  }
});

// The same, where the collaborator's deletion is right after an earlier one
// of theirs: Yjs merges the two deleted items, and the merged item's first
// id is the earlier deletion's. The passed line still counts as holding the
// change, and nothing it deleted comes back.
describe('a change not read yet deletes text next to an earlier deletion in a line a moved line passes', () => {
  for (const gc of GC) {
    test(`gc ${gc}`, async () => {
      const t = await setup(() => {}, {gc, ids: [1, 2, 3]});
      const {a, b} = t;
      b.update(() => {
        $getRoot()
          .clear()
          .append(
            ...['aa', 'bbb', 'tail'].map(text =>
              $createParagraphNode().append($text(text)),
            ),
          );
      });
      await t.sync();
      const $bbb = () =>
        $getRoot()
          .getAllTextNodes()
          .find(n => /^b+$/.test(n.getTextContent()))!;
      b.update(() => {
        $bbb().spliceText(0, 1, '');
        $setSelection(null);
      });
      await t.sync();
      t.offline();
      const seen = Y.encodeStateVector(b.doc);
      b.update(() => {
        $bbb().spliceText(0, 1, '');
        $getRoot()
          .getAllTextNodes()
          .find(n => n.getTextContent() === 'aa')!
          .spliceText(1, 0, 'X');
        $setSelection(null);
      });
      const delta = Y.encodeStateAsUpdate(b.doc, seen);
      a.update(() => {
        Y.applyUpdate(a.doc, delta, 'provider');
        $getRoot().append($getRoot().getFirstChildOrThrow());
      });
      await t.sync();
      for (const p of t.peers) {
        expect(p.read(() => $getRoot().getTextContent())).not.toContain('bb');
      }
      expect(a.describe()).toBe((await freshReader(a)).describe());
      await expectConverged(t.peers);
    });
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
