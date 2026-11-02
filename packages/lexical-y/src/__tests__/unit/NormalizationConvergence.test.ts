/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The normalization every peer enforces (NodeStructureExtension, registered
// by the binding). Content written without it (an update with
// skipTransforms) is normalized by its author, in its own edit; what
// concurrent edits leave is shown as stored until a local edit normalizes
// it, as that edit. Whatever the delivery order and the client ids, the
// peers converge with no duplicate and no loss.
import {
  $createHorizontalRuleNode,
  HorizontalRuleNode,
} from '@lexical/extension';
import {$createLinkNode, LinkNode} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  type ListItemNode,
} from '@lexical/list';
import {$createMarkNode} from '@lexical/mark';
import {$createHeadingNode, $createQuoteNode} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  createEditor,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  ParagraphNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {afterAll, describe, expect, test} from 'vitest';

import {createYDoc, YBinding, type YDoc} from '../..';
import {
  $block,
  $createBoxNode,
  $p,
  $selectIn,
  describeNode,
  expectConverged,
  flush,
  freshReader,
  mainNormalizes,
  NODES,
  type Peer,
  type Setup,
  setup,
} from '../utils/harness';

/** Run `fn` on `peer` without Lexical's transforms (no normalization). */
function unnormalized(peer: Peer, fn: () => void) {
  peer.editor.update(fn, {discrete: true, skipTransforms: true});
}

function count(text: string, tok: string): number {
  return text.split(tok).length - 1;
}

/**
 * Converged (every peer and a fresh reader, no self-check warning), every
 * token exactly once, and nothing left for Lexical's normalization to
 * change.
 */
async function expectClean(t: Setup, tokens: string[]) {
  await expectConverged(t.peers);
  const fresh = await freshReader(t.a);
  const text = t.a.read(() => $getRoot().getTextContent());
  for (const tok of tokens) {
    expect([tok, count(text, tok)]).toEqual([tok, 1]);
  }
  for (const peer of [...t.peers, fresh]) {
    // Lexical's own normalization of the whole document changes nothing.
    expect(mainNormalizes(peer)).toBe(null);
  }
}

type Case = {
  name: string;
  init?: () => void;
  tokens: string[];
  /** Produces the violation; `t.a` is the author. */
  run: (t: Setup) => void;
  /** Two peers' concurrent edits produce it (always written offline). */
  concurrent?: boolean;
  /** The normalized shape every peer must show (see shapeOf). */
  shape?: unknown[];
  /**
   * Documented limit: the peers' later edits (below) each normalize what the
   * concurrent edits left, at once when delivered in sender order, each as
   * its own move: the moved content shows once per peer.
   */
  concurrentNormalization?: boolean;
};

/**
 * The root's blocks: a block's type and text (line breaks as `/`), a list's
 * start and items.
 */
function shapeOf(peer: Peer): unknown[] {
  return peer.read(() =>
    $getRoot()
      .getChildren()
      .map(n =>
        $isListNode(n)
          ? [
              `${n.getListType()} ${n.getStart()}`,
              ...n.getChildren().map(textOf),
            ]
          : $isElementNode(n)
            ? [n.getType(), textOf(n)]
            : [n.getType()],
      ),
  );
}

function textOf(n: LexicalNode): string {
  return n.getTextContent().replace(/\n/g, '/');
}

/** Paragraphs put into a list item (ListItemNode.append would unwrap them). */
function $itemWith(...blocks: LexicalNode[]): ListItemNode {
  const item = $createListItemNode();
  item.splice(0, 0, blocks);
  return item;
}

const $lr = () =>
  $createParagraphNode().append(
    $createTextNode('left'),
    $createBoxNode().append($p('boxed')),
    $createTextNode('right'),
  );

const CASES: Case[] = [
  {
    name: 'stray block inside a paragraph (unnormalized write)',
    run: t => unnormalized(t.a, () => $getRoot().append($lr())),
    tokens: ['start', 'left', 'boxed', 'right'],
  },
  {
    name: 'stray block at the start of a paragraph (unnormalized write)',
    run: t =>
      unnormalized(t.a, () =>
        $getRoot().append(
          $createParagraphNode().append(
            $createBoxNode().append($p('boxed')),
            $createTextNode('right'),
          ),
        ),
      ),
    tokens: ['start', 'boxed', 'right'],
  },
  {
    name: 'block as the only child of a paragraph (unnormalized write)',
    run: t =>
      unnormalized(t.a, () =>
        $getRoot().append(
          $createParagraphNode().append($createBoxNode().append($p('boxed'))),
        ),
      ),
    tokens: ['start', 'boxed'],
  },
  {
    name: 'heading held by a list item (unnormalized write)',
    run: t =>
      unnormalized(t.a, () =>
        $getRoot().append(
          $createListNode('bullet').append(
            $createListItemNode().append(
              $createTextNode('item'),
              $createHeadingNode('h2').append($createTextNode('head')),
            ),
          ),
        ),
      ),
    tokens: ['start', 'item', 'head'],
  },
  {
    name: 'inline content directly in a table cell (unnormalized write)',
    run: t =>
      unnormalized(t.a, () =>
        $getRoot().append(
          $createTableNode().append(
            $createTableRowNode().append(
              $createTableCellNode().append($createTextNode('cell')),
            ),
          ),
        ),
      ),
    tokens: ['start', 'cell'],
  },
  {
    name: 'a link directly in the root (unnormalized write)',
    run: t =>
      unnormalized(t.a, () =>
        $getRoot().append(
          $createLinkNode('https://x').append($createTextNode('LNK')),
        ),
      ),
    shape: [
      ['paragraph', 'start'],
      ['paragraph', 'LNK'],
    ],
    tokens: ['start', 'LNK'],
  },
  {
    name: 'a link and a mark directly in a table cell (unnormalized write)',
    run: t =>
      unnormalized(t.a, () =>
        $getRoot().append(
          $createTableNode().append(
            $createTableRowNode().append(
              $createTableCellNode().append(
                $createLinkNode('https://x').append($createTextNode('LNK')),
              ),
              $createTableCellNode().append(
                $createMarkNode(['m']).append($createTextNode('MRK')),
              ),
            ),
          ),
        ),
      ),
    tokens: ['start', 'LNK', 'MRK'],
  },
  {
    name: 'adjacent equal links (unnormalized write)',
    run: t =>
      unnormalized(t.a, () =>
        $getRoot().append(
          $createParagraphNode().append(
            $createLinkNode('https://a').append($createTextNode('L1')),
            $createLinkNode('https://a').append($createTextNode('L2')),
          ),
        ),
      ),
    tokens: ['start', 'L1', 'L2'],
  },
  {
    name: 'adjacent lists of one type (unnormalized write)',
    run: t =>
      unnormalized(t.a, () =>
        $getRoot().append(
          $createListNode('bullet').append(
            $createListItemNode().append($createTextNode('A')),
          ),
          $createListNode('bullet').append(
            $createListItemNode().append($createTextNode('B')),
          ),
        ),
      ),
    tokens: ['start', 'A', 'B'],
  },
  {
    init: () =>
      $getRoot().append(
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('item')),
        ),
      ),
    name: 'adjacent equal lists inside a list item (unnormalized write)',
    run: t =>
      unnormalized(t.a, () =>
        ($block([0, 0]) as ElementNode).append(
          $createListNode('check').append(
            $createListItemNode().append($createTextNode('A')),
          ),
          $createListNode('check').append(
            $createListItemNode().append($createTextNode('B')),
          ),
        ),
      ),
    tokens: ['item', 'A', 'B'],
  },
  {
    name: 'paragraphs held by a quote (unnormalized write)',
    run: t =>
      unnormalized(t.a, () =>
        $getRoot().append($createQuoteNode().append($p('q1'), $p('q2'))),
      ),
    shape: [
      ['paragraph', 'start'],
      ['quote', 'q1/q2'],
    ],
    tokens: ['start', 'q1', 'q2'],
  },
  {
    name: 'paragraphs and a heading held by a quote (unnormalized write)',
    run: t =>
      unnormalized(t.a, () =>
        $getRoot().append(
          $createQuoteNode().append(
            $createTextNode('q0'),
            $p('q1'),
            $createHeadingNode('h2').append($createTextNode('head')),
            $p('q2'),
          ),
        ),
      ),
    shape: [
      ['paragraph', 'start'],
      ['quote', 'q0/q1'],
      ['heading', 'head'],
      ['quote', 'q2'],
    ],
    tokens: ['start', 'q0', 'q1', 'head', 'q2'],
  },
  {
    name: 'paragraphs held by a list item (unnormalized write)',
    run: t =>
      unnormalized(t.a, () =>
        $getRoot().append(
          $createListNode('bullet').append(
            $itemWith($p('i1'), $p('i2')),
            $createListItemNode().append($createTextNode('i3')),
          ),
        ),
      ),
    shape: [
      ['paragraph', 'start'],
      ['bullet 1', 'i1/i2', 'i3'],
    ],
    tokens: ['start', 'i1', 'i2', 'i3'],
  },
  {
    init: () =>
      $getRoot().append(
        $createListNode('number').append(
          $createListItemNode().append($createTextNode('one')),
          $createListItemNode().append($createTextNode('two')),
          $createListItemNode().append($createTextNode('three')),
        ),
      ),
    name: 'a horizontal rule held by a numbered list item (unnormalized write)',
    run: t =>
      unnormalized(t.a, () =>
        ($block([0, 1]) as ElementNode).append($createHorizontalRuleNode()),
      ),
    // The items after the rule keep their numbers.
    shape: [
      ['number 1', 'one', 'two'],
      ['horizontalrule'],
      ['number 3', 'three'],
    ],
    tokens: ['one', 'two', 'three'],
  },
  {
    init: () =>
      $getRoot().append(
        $createListNode('number').append(
          $createListItemNode().append($createTextNode('one')),
          $createListItemNode().append($createTextNode('two')),
          $createListItemNode().append($createTextNode('three')),
        ),
      ),
    name: 'a horizontal rule as all of a numbered list item (unnormalized write)',
    run: t =>
      unnormalized(t.a, () =>
        ($block([0, 1]) as ElementNode)
          .clear()
          .append($createHorizontalRuleNode()),
      ),
    shape: [['number 1', 'one'], ['horizontalrule'], ['number 2', 'three']],
    tokens: ['one', 'three'],
  },
  {
    concurrent: true,
    init: () =>
      $getRoot().append($createQuoteNode().append($createTextNode('quote'))),
    name: 'a paragraph written into a quote ‖ typing in the quote',
    run: t => {
      unnormalized(t.a, () => ($block([0]) as ElementNode).append($p('para')));
      t.b.update(() => $selectIn([0], 0).insertText('X'));
    },
    shape: [['quote', 'Xquote/para']],
    tokens: ['Xquote', 'para'],
  },
  {
    concurrent: true,
    init: () =>
      $getRoot().append(
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('item')),
        ),
      ),
    name: 'a paragraph written into a list item ‖ typing in the item',
    run: t => {
      unnormalized(t.a, () => {
        const item = $block([0, 0]) as ElementNode;
        item.getLastChildOrThrow().insertAfter($p('para'));
      });
      t.b.update(() => $selectIn([0, 0], 0).insertText('X'));
    },
    shape: [['bullet 1', 'Xitem/para']],
    tokens: ['Xitem', 'para'],
  },
  {
    concurrent: true,
    init: () =>
      $getRoot().append(
        $createTableNode().append(
          $createTableRowNode().append(
            $createTableCellNode().append($p('cell')),
          ),
        ),
      ),
    name: 'inline content left in a table cell by a removal ‖ typing',
    run: t => {
      t.a.update(() => ($block([0, 0, 0, 0]) as ElementNode).remove());
      t.b.update(() => $selectIn([0, 0, 0, 0], 4).insertText('X'));
    },
    tokens: ['X'],
  },
  {
    concurrent: true,
    init: () => $getRoot().append($p('L1L2')),
    name: 'equal links created side by side concurrently',
    run: t => {
      t.a.update(() => {
        const text = $assertNodeType(
          $block([0]).getFirstChildOrThrow(),
          $isTextNode,
        );
        const [l1] = text.splitText(2);
        l1.replace($createLinkNode('https://a').append($createTextNode('L1')));
      });
      t.b.update(() => {
        const text = $assertNodeType(
          $block([0]).getLastChildOrThrow(),
          $isTextNode,
        );
        const [, l2] = text.splitText(text.getTextContentSize() - 2);
        l2.replace($createLinkNode('https://a').append($createTextNode('L2')));
      });
    },
    tokens: ['L1', 'L2'],
  },
  {
    // Each peer's own edit moves its list into an item of its own (a list
    // item holding a nested list holds nothing else), so nothing is left for
    // the later edits to normalize at once (formerly the documented limit
    // below: the moved list showed once per peer).
    concurrent: true,
    init: () =>
      $getRoot().append(
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('item')),
        ),
      ),
    name: 'equal lists added to one list item concurrently',
    run: t => {
      for (const [peer, tok] of [
        [t.a, 'A'],
        [t.b, 'B'],
      ] as const) {
        peer.update(() =>
          ($block([0, 0]) as ElementNode).append(
            $createListNode('check').append(
              $createListItemNode().append($createTextNode(tok)),
            ),
          ),
        );
      }
    },
    tokens: ['item', 'A', 'B'],
  },
];

type Schedule = {
  name: string;
  delivery?: 'causal' | 'sender';
  /** Peers online while the violation is produced (live delivery). */
  live?: boolean;
  /** Deliveries before the final sync: [from, to] peer indexes. */
  first?: [number, number][];
  /** An unrelated local edit of peer c before it syncs. */
  edit?: boolean;
};

const SCHEDULES: Schedule[] = [
  {live: true, name: 'all online'},
  {name: 'offline, then one sync'},
  {delivery: 'sender', name: 'offline, then one sync in sender order'},
  {first: [[0, 1]], name: 'a to b first, then sync'},
  {first: [[0, 2]], name: 'a to c first, then sync'},
  {
    first: [
      [0, 1],
      [1, 2],
      [0, 2],
    ],
    name: "b's updates reach c before a's change",
  },
  {
    first: [
      [0, 1],
      [0, 2],
    ],
    name: 'a to b and to c first, then sync',
  },
  {edit: true, name: 'c edits elsewhere before it syncs'},
];

/** Deliver what `from` sent while offline to `to`. */
function deliver(from: Peer, to: Peer) {
  const list = to.pending.get(from);
  if (list !== undefined && list.length > 0) {
    to.pending.delete(from);
    Y.applyUpdate(
      to.doc,
      Y.mergeUpdates(list as Uint8Array<ArrayBuffer>[]),
      to.net,
    );
  }
}

const ID_ORDERS = [
  [1, 2, 3],
  [1, 3, 2],
  [2, 1, 3],
  [2, 3, 1],
  [3, 1, 2],
  [3, 2, 1],
];

describe('unnormalized content converges with no duplicate and no loss (3 peers)', () => {
  for (const c of CASES) {
    describe(c.name, () => {
      for (const s of SCHEDULES) {
        test.each(ID_ORDERS)(`${s.name}, ids %i,%i,%i`, async (...ids) => {
          const t = await setup(
            c.init ?? (() => $getRoot().append($p('start'))),
            {delivery: s.delivery, ids, nodes: [...NODES, HorizontalRuleNode]},
          );
          if (!s.live || c.concurrent) {
            t.offline();
          }
          c.run(t);
          if (s.edit) {
            t.c.update(() => {
              const first = $getRoot().getFirstChild();
              if (first instanceof ParagraphNode) {
                first.append($createTextNode(' zz'));
              } else {
                $getRoot().append($p('zz'));
              }
            });
          }
          for (const [from, to] of s.first ?? []) {
            deliver(t.peers[from], t.peers[to]);
            await flush();
          }
          await t.sync();
          // A later edit of each peer (transforms on): Lexical's
          // normalization of what is left is that peer's own edit.
          for (const peer of t.peers) {
            peer.update(() => {
              for (const n of $getRoot().getChildren()) {
                (n as ElementNode).markDirty();
              }
            });
          }
          await t.sync();
          if (c.concurrentNormalization && s.delivery === 'sender') {
            await expectConverged(t.peers);
            const fresh = await freshReader(t.a);
            expect(fresh.describe()).toBe(t.a.describe());
            const text = t.a.read(() => $getRoot().getTextContent());
            // The list that moves shows once per peer, the other once.
            const [first, ...rest] = c.tokens.map(tok => count(text, tok));
            expect([first, ...rest.sort()]).toEqual([1, 1, 3]);
            return;
          }
          await expectClean(t, s.edit ? [...c.tokens, 'zz'] : c.tokens);
          if (c.shape !== undefined && !s.edit) {
            for (const peer of t.peers) {
              expect(shapeOf(peer)).toEqual(c.shape);
            }
          }
        });
      }
    });
  }
});

/** The names of the shared nodes anywhere in `peer`'s document. */
function storedNames(peer: Peer): string[] {
  const out: string[] = [];
  const visit = (y: Y.Node) => {
    for (let it = y._start; it !== null; it = it.right) {
      if (!it.deleted && it.content instanceof Y.ContentType) {
        const child = it.content.type as Y.Node;
        out.push(String(child.name));
        visit(child);
      }
    }
  };
  visit(peer.binding.root);
  return out;
}

// A full replacement of the editor state (setEditorState with a state the
// editor did not parse, such as one built with skipTransforms elsewhere) is
// normalized by its author like any update that ran no transforms: the
// author ends up where a fresh reader of what it wrote is, with no self-check
// to bring it there.
test('a setEditorState replacement is normalized by its author, who matches a fresh reader', async () => {
  const client = (doc: YDoc) => {
    const editor = createEditor({
      nodes: NODES,
      onError: e => {
        throw e;
      },
    });
    const binding = new YBinding(editor, doc, {schemaVersion: 1});
    binding.start();
    return {binding, editor};
  };
  const tree = (editor: LexicalEditor) =>
    editor.read(() => $getRoot().getChildren().map(describeNode).join(' / '));
  const doc = createYDoc(null, {gc: false});
  const a = client(doc);
  a.editor.update(() => $getRoot().append($p('base')), {discrete: true});
  a.binding.initialize();
  const source = createEditor({
    nodes: NODES,
    onError: e => {
      throw e;
    },
  });
  source.update(
    () =>
      $getRoot().append(
        $createParagraphNode().append(
          $createTextNode('left'),
          $createTableNode().append(
            $createTableRowNode().append(
              $createTableCellNode().append($p('cell')),
            ),
          ),
          $createTextNode('right'),
        ),
      ),
    {discrete: true, skipTransforms: true},
  );
  a.editor.setEditorState(source.getEditorState());
  await flush();
  const copy = createYDoc(null, {gc: false});
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  const fresh = client(copy);
  fresh.binding.initialize();
  await flush();
  expect(tree(a.editor)).toBe(
    'paragraph("left") / table(tablerow(tablecell(paragraph("cell")))) / paragraph("right")',
  );
  expect(tree(fresh.editor)).toBe(tree(a.editor));
});

// The normalization runs on what a local update writes: typing in a table
// cell's text, written without a paragraph inside a paragraph, wraps the
// text and lifts the table in that update. The writer writes the cell's line
// twice (in the paragraph, then where the table is lifted to); the
// self-check compares the line where it was written last.
test('a lift and a wrap written by one local update converge, with no self-check warning', async () => {
  const t = await setup(() => $getRoot().append($p('alpha'), $p('gamma')));
  t.offline();
  unnormalized(t.a, () =>
    ($block([0]) as ElementNode).append(
      $createTableNode().append(
        $createTableRowNode().append(
          $createTableCellNode().append($createTextNode('cell')),
        ),
      ),
    ),
  );
  t.a.update(() => {
    const cell = $getRoot()
      .getAllTextNodes()
      .find(n => n.getTextContent() === 'cell')!;
    cell.spliceText(0, 0, 'Z');
  });
  expect(t.a.describe()).toBe(
    'paragraph("alpha") / table(tablerow(tablecell(paragraph("Zcell")))) / paragraph("gamma")',
  );
  expect(t.a.warnings).toEqual([]);
  await t.sync();
  await expectClean(t, ['alpha', 'Zcell', 'gamma']);
});

// A line written inside a line (an update without the normalization) is
// stored as the lines the normalization leaves, never as a node of its own
// inside the line: later splits of it keep their text's items.
describe('a line written inside a line is stored as lines', () => {
  const RUNS = ID_ORDERS.flatMap(ids =>
    (['causal', 'sender'] as const).map(delivery => ({delivery, ids})),
  );
  const $list = () =>
    $getRoot().append(
      $createListNode('bullet').append(
        $createListItemNode().append($createTextNode('item')),
      ),
    );
  test.each(RUNS)(
    'a heading written inside a list item ‖ typing next to it and in it (%o)',
    async ({ids, delivery}) => {
      const t = await setup($list, {delivery, ids});
      t.offline();
      unnormalized(t.a, () =>
        ($block([0, 0]) as ElementNode).append(
          $createHeadingNode('h2').append($createTextNode('head')),
        ),
      );
      // c types next to the heading before it sees it.
      t.c.update(() => $selectIn([0, 0], 4).insertText('Z'));
      deliver(t.a, t.b);
      deliver(t.a, t.c);
      await flush();
      t.b.update(() => $selectIn([1], 4).insertText('B'));
      t.c.update(() => $selectIn([1], 0).insertText('C'));
      await t.sync();
      await expectClean(t, ['itemZ', 'CheadB']);
      expect(storedNames(t.a)).not.toContain('i:heading');
    },
  );

  test.each(RUNS)(
    'a heading written inside a list item ‖ an Enter in it ‖ typing in both parts (%o)',
    async ({ids, delivery}) => {
      const t = await setup($list, {delivery, ids});
      t.offline();
      unnormalized(t.a, () =>
        ($block([0, 0]) as ElementNode).append(
          $createHeadingNode('h2').append($createTextNode('head tail')),
        ),
      );
      deliver(t.a, t.b);
      deliver(t.a, t.c);
      await flush();
      t.a.update(() => $selectIn([1], 0).insertText('A'));
      t.b.update(() => $selectIn([1], 4).insertParagraph());
      t.c.update(() => $selectIn([1], 9).insertText('C'));
      await t.sync();
      await expectClean(t, ['item', 'Ahead', 'tailC']);
      expect(storedNames(t.a)).not.toContain('i:heading');
    },
  );

  test.each(RUNS)(
    "a paragraph written in front of a list item's text it starts like ‖ the item's text rewritten (%o)",
    async ({ids, delivery}) => {
      const t = await setup($list, {delivery, ids});
      t.offline();
      // 'itch' is new text in front of 'item': it must not take the item's
      // first characters ('it'), which b's rewrite below removes.
      unnormalized(t.a, () =>
        ($block([0, 0]) as ElementNode).splice(0, 0, [$p('itch')]),
      );
      // b writes a paragraph into the item too, then an Enter at its start
      // before its normalization ran: one update joins the paragraph and
      // splits the item, which rewrites the item's text.
      unnormalized(t.b, () =>
        ($block([0, 0]) as ElementNode).splice(1, 0, [$p('end')]),
      );
      t.b.update(() => $selectIn([0, 0], 0).insertParagraph());
      await t.sync();
      await expectClean(t, ['itch', 'item', 'end']);
    },
  );

  test.each(RUNS)(
    'a heading written into an empty list item, then another edit before the normalization (%o)',
    async ({ids, delivery}) => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createListNode('bullet').append(
              $createListItemNode().append($createTextNode('item')),
              $createListItemNode(),
            ),
          ),
        {delivery, ids},
      );
      t.offline();
      // The item holds nothing but the heading (no part of its own), and
      // the next write does not touch it.
      unnormalized(t.a, () =>
        ($block([0, 1]) as ElementNode).append(
          $createHeadingNode('h2').append($createTextNode('head')),
        ),
      );
      unnormalized(t.a, () => $getRoot().append($p('more')));
      // Stored as lines from the first write on (before the normalization).
      expect(storedNames(t.a)).not.toContain('i:heading');
      await t.sync();
      await expectClean(t, ['item', 'head', 'more']);
      expect(storedNames(t.a)).not.toContain('i:heading');
    },
  );

  test.each(RUNS)(
    "a heading written as a list item's first child ‖ typing in it (%o)",
    async ({ids, delivery}) => {
      const t = await setup($list, {delivery, ids});
      t.offline();
      unnormalized(t.a, () =>
        ($block([0, 0]) as ElementNode)
          .getFirstChildOrThrow()
          .insertBefore(
            $createHeadingNode('h2').append($createTextNode('head')),
          ),
      );
      deliver(t.a, t.b);
      await flush();
      // b sees the heading before a's normalization makes it a list item.
      t.b.update(() => {
        const head = $getRoot()
          .getAllTextNodes()
          .find(n => n.getTextContent() === 'head')!;
        head.select(4, 4).insertText('B');
      });
      await t.sync();
      await expectClean(t, ['headB', 'item']);
      expect(storedNames(t.a)).not.toContain('i:heading');
    },
  );
});

// ---------------------------------------------------------------------------
// Fuzz: 3 peers, partial delivery, edits written with and without the
// normalization.

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
  return {
    int: (n: number) => Math.floor(next() * n),
    p: (x: number) => next() < x,
    pick: <T>(a: readonly T[]): T => a[Math.floor(next() * a.length)],
  };
}

let tokenCounter = 0;
const token = () => `t${(tokenCounter++).toString(36)}q`;

/** Offsets in `text` outside every token (so typing never splits one). */
function boundaries(text: string): number[] {
  const out = [0, text.length];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ') {
      out.push(i, i + 1);
    }
  }
  return out;
}

/** One random edit; never deletes text, so loss or duplication shows. */
function $edit(r: ReturnType<typeof rng>, typed: string[]): string {
  const root = $getRoot();
  const blocks = root.getChildren() as ElementNode[];
  const texts = root.getAllTextNodes();
  const k = r.int(9);
  const tok = token();
  if (k <= 2 && texts.length > 0) {
    typed.push(tok);
    const node = r.pick(texts);
    node.spliceText(r.pick(boundaries(node.getTextContent())), 0, ` ${tok} `);
    return `type ${tok}`;
  }
  const block = r.pick(blocks);
  if (k === 3 && block.getChildrenSize() > 0 && !block.isShadowRoot()) {
    // A stray block in a block's content.
    typed.push(tok);
    block.splice(r.int(block.getChildrenSize() + 1), 0, [
      $createBoxNode().append($p(tok)),
    ]);
    return `box ${tok} into ${block.getType()}`;
  }
  if (k === 4) {
    typed.push(tok);
    block.insertAfter(
      $createListNode('bullet').append(
        $createListItemNode().append($createTextNode(tok)),
      ),
    );
    return `list ${tok}`;
  }
  if (k === 5 && texts.length > 0) {
    typed.push(tok);
    const links = texts
      .map(n => n.getParent())
      .filter((p): p is LinkNode => p instanceof LinkNode);
    const created = $createLinkNode('https://a').append($createTextNode(tok));
    if (links.length > 0) {
      r.pick(links).insertAfter(created);
    } else {
      r.pick(texts).insertAfter(created);
    }
    return `link ${tok}`;
  }
  if (k === 6) {
    const items = texts
      .map(n => n.getParent())
      .filter((p): p is ListItemNode => $isListItemNode(p));
    if (items.length > 0) {
      const item = r.pick(items);
      typed.push(tok);
      item.append($createHeadingNode('h3').append($createTextNode(tok)));
      return `heading ${tok} into an item`;
    }
  }
  if (k === 7 && texts.length > 0) {
    const node = r.pick(texts);
    const at = r.pick(boundaries(node.getTextContent()));
    node.select(at, at).insertParagraph();
    return 'enter';
  }
  if (block instanceof ParagraphNode && texts.length > 0) {
    typed.push(tok);
    block.append(
      $createTableNode().append(
        $createTableRowNode().append(
          $createTableCellNode().append($createTextNode(tok)),
        ),
      ),
    );
    return `table ${tok} into a paragraph`;
  }
  return 'noop';
}

const FUZZ_SUMMARY = {
  duplicated: [] as number[],
  healed: [] as number[],
  seeds: 0,
};

describe('fuzz: unnormalized writes by 3 peers with partial delivery', () => {
  const SEEDS = Number(process.env.NORMALIZE_FUZZ_SEEDS ?? 100);
  // Seeds of runs of 2,000 that found bugs since fixed: an author's
  // normalization that ran after a remote change was read (which gave the
  // nodes it wrote new ones), so it lost typing or left the update
  // unnormalized.
  const FOUND = [120, 285, 569, 772, 1599, 1719, 1753, 1894, 1989];
  test.each([
    ...Array.from({length: SEEDS}, (_, i) => i + 1),
    ...FOUND.filter(seed => seed > SEEDS),
  ])('seed %i', async seed => {
    const r = rng(7000 + seed);
    const t = await setup(
      () =>
        $getRoot().append(
          $p('alpha beta'),
          $createListNode('bullet').append(
            $createListItemNode().append($createTextNode('one')),
          ),
          $p('gamma'),
        ),
      {
        delivery: r.p(0.5) ? 'causal' : 'sender',
        ids: r.pick(ID_ORDERS),
      },
    );
    const typed: string[] = [];
    const trace: string[] = [];
    for (let round = 0; round < 4; round++) {
      for (const peer of t.peers) {
        peer.online = r.p(0.5);
      }
      for (const [pi, peer] of t.peers.entries()) {
        const n = r.int(3);
        for (let i = 0; i < n; i++) {
          const raw = r.p(Number(process.env.NORMALIZE_FUZZ_RAW ?? 0.4));
          const $fn = () => {
            trace.push(
              `r${round} p${pi + 1}${raw ? ' raw' : ''}: ${$edit(r, typed)}`,
            );
          };
          if (raw) {
            unnormalized(peer, $fn);
          } else {
            peer.update($fn);
          }
        }
      }
      if (r.p(0.5)) {
        await t.sync();
        trace.push(`synced = ${t.a.describe()}`);
      }
    }
    await t.sync();
    // Then a full state exchange, as a provider's sync on reconnect: the
    // harness's merged partial deliveries can leave a peer holding pending
    // structs it never gets the start of (seen without any normalization
    // too); a state exchange delivers everything.
    for (let round = 0; round < 3; round++) {
      for (const from of t.peers) {
        for (const to of t.peers) {
          if (from !== to) {
            Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc), to.net);
          }
        }
      }
      await t.sync();
    }
    if (process.env.NORMALIZE_FUZZ_TRACE === String(seed)) {
      // eslint-disable-next-line no-console
      console.log(trace.join('\n'));
    }
    // Converged: every peer and a fresh reader show the same tree. A
    // remote self-check mismatch is healed by reading again (counted).
    const first = t.a.describe();
    for (const peer of t.peers) {
      expect(peer.errors).toEqual([]);
      expect(peer.describe()).toBe(first);
    }
    const fresh = await freshReader(t.a);
    expect(fresh.describe()).toBe(first);
    const text = t.a.read(() => $getRoot().getTextContent());
    const lost = typed.filter(tok => count(text, tok) === 0);
    const dup = typed.filter(tok => count(text, tok) > 1);
    expect({lost, seed}).toEqual({lost: [], seed});
    FUZZ_SUMMARY.seeds++;
    if (dup.length > 0) {
      // Two peers normalized one shape at once, each as its own move (see
      // the README, Limits).
      FUZZ_SUMMARY.duplicated.push(seed);
    }
    if (t.peers.some(p => p.warnings.some(w => w.includes('self-check')))) {
      FUZZ_SUMMARY.healed.push(seed);
    }
    for (const peer of [...t.peers, fresh]) {
      expect({main: mainNormalizes(peer), seed}).toEqual({
        main: null,
        seed,
      });
    }
  });
  afterAll(() => {
    // eslint-disable-next-line no-console
    console.log('normalization fuzz: ' + JSON.stringify(FUZZ_SUMMARY));
  });
});
