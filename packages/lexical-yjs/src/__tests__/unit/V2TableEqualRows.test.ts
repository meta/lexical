/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// #9581. When the v2 binding writes a local change, a Lexical node equal to
// a Y type it was not mapped to (an equal table row) is mapped to that type;
// its descendants kept their old mappings, so a later remote change to the
// row read another row's cells into it.
//
// Three @lexical/yjs v2 peers (wired like the React collaboration plugin)
// edit one table concurrently: row and column inserts and typing, with a few
// messages delivered between the edits, then every message delivered (each
// channel in order). Once nothing is left to deliver, every editor should
// show what its own Y.Doc holds, and the peers should agree. Before the fix,
// peer A's editor ended with a row that has no cells, while A's own document
// (read by a fresh v2 peer) and peers B and C have two cells in that row.

import {$createCodeHighlightNode, CodeHighlightNode} from '@lexical/code';
import {buildEditorFromExtensions} from '@lexical/extension';
import {$createHashtagNode, HashtagNode} from '@lexical/hashtag';
import {$createLinkNode, LinkNode} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  ListExtension,
} from '@lexical/list';
import {$createMarkNode, MarkNode} from '@lexical/mark';
import {$createQuoteNode, RichTextExtension} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $insertTableColumnAtSelection,
  $insertTableRowAtSelection,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  TableCellHeaderStates,
  type TableCellNode,
  TableExtension,
} from '@lexical/table';
import {
  type BindingV2,
  createBindingV2__EXPERIMENTAL,
  type Provider,
  syncLexicalUpdateToYjsV2__EXPERIMENTAL,
  syncYjsChangesToLexicalV2__EXPERIMENTAL,
} from '@lexical/yjs';
import {
  $create,
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTabNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $getSlot,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  $setSlot,
  DecoratorNode,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  ParagraphNode,
  SKIP_COLLAB_TAG,
  type TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';
import {
  applyUpdate,
  Doc,
  encodeStateAsUpdate,
  UndoManager,
  type XmlElement,
} from 'yjs';

const REMOTE = 'remote';
const provider = {
  awareness: {
    getLocalState: () => null,
    getStates: () => new Map(),
    off: () => {},
    on: () => {},
    setLocalState: () => {},
    setLocalStateField: () => {},
  },
  connect: () => {},
  disconnect: () => {},
  off: () => {},
  on: () => {},
} as unknown as Provider;

type Message = {from: Peer; to: Peer; update: Uint8Array};

/** A paragraph with a named slot (a slot host). */
class SlottedNode extends ParagraphNode {
  $config() {
    return this.config('v2-equal-slotted', {
      extends: ParagraphNode,
      slots: ['title'],
    });
  }
}

/** A decorator with no content. */
class LeafNode extends DecoratorNode<null> {
  $config() {
    return this.config('v2-equal-leaf', {extends: DecoratorNode});
  }
  createDOM() {
    return document.createElement('span');
  }
  updateDOM() {
    return false;
  }
  decorate() {
    return null;
  }
}

class Peer {
  readonly doc: Doc;
  readonly editor: LexicalEditor & {dispose: () => void};
  readonly binding: BindingV2;

  constructor(
    readonly name: string,
    clientID: number,
    queue: Message[] | null,
    peers: Peer[],
    gc = false,
  ) {
    this.doc = new Doc({gc});
    this.doc.clientID = clientID;
    this.editor = buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [ListExtension, TableExtension, RichTextExtension],
      name: `[v2-table-${name}]`,
      nodes: () => [
        LinkNode,
        MarkNode,
        HashtagNode,
        CodeHighlightNode,
        SlottedNode,
        LeafNode,
      ],
      onError: e => {
        throw e;
      },
    });
    const binding = createBindingV2__EXPERIMENTAL(
      this.editor,
      'main',
      this.doc,
      new Map([['main', this.doc]]),
    );
    this.binding = binding;
    (binding.root as XmlElement).observeDeep(((
      events: never,
      transaction: {origin: unknown},
    ) => {
      if (transaction.origin !== binding) {
        syncYjsChangesToLexicalV2__EXPERIMENTAL(
          binding,
          provider,
          events,
          transaction as never,
          transaction.origin instanceof UndoManager,
        );
      }
    }) as never);
    this.editor.registerUpdateListener(
      ({
        prevEditorState,
        editorState,
        dirtyElements,
        dirtyLeaves,
        normalizedNodes,
        tags,
      }) => {
        if (!tags.has(SKIP_COLLAB_TAG)) {
          syncLexicalUpdateToYjsV2__EXPERIMENTAL(
            binding,
            provider,
            prevEditorState,
            editorState,
            dirtyElements,
            dirtyLeaves,
            normalizedNodes,
            tags,
          );
        }
      },
    );
    this.editor.read(() => {});
    if (queue !== null) {
      this.doc.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin !== REMOTE) {
          for (const to of peers) {
            if (to !== this) {
              queue.push({from: this, to, update});
            }
          }
        }
      });
    }
  }

  update(fn: () => void) {
    this.editor.update(fn, {discrete: true});
    this.flush();
  }

  apply(update: Uint8Array) {
    applyUpdate(this.doc, update, REMOTE);
    this.flush();
  }

  flush() {
    for (let i = 0; i < 20 && this.editor._pendingEditorState !== null; i++) {
      this.editor.read(() => {});
    }
  }

  /** The editor's whole state, as JSON. */
  json(): unknown {
    this.flush();
    return this.editor.getEditorState().toJSON();
  }

  dispose() {
    this.editor.dispose();
    this.doc.destroy();
  }

  /** Cells per row of the table. */
  rows(): number[] {
    return this.editor.read(() => {
      const table = $getRoot().getChildren().find($isTableNode)!;
      return table
        .getChildren()
        .filter($isTableRowNode)
        .map(row => row.getChildrenSize());
    });
  }
}

const $p = (...texts: string[]) =>
  $createParagraphNode().append(...texts.map(t => $createTextNode(t)));

/** A 2x2 table (a header row; a numbered list in a cell) and a paragraph. */
function $build() {
  const header = (text: string) =>
    $createTableCellNode(TableCellHeaderStates.ROW).append($p(text));
  const list = $createListNode('number', 3).append(
    ...['first number', 'second number', 'third number'].map(t =>
      $createListItemNode().append($createTextNode(t)),
    ),
  );
  $getRoot()
    .clear()
    .append(
      $createTableNode().append(
        $createTableRowNode().append(header('h1'), header('h2')),
        $createTableRowNode().append(
          $createTableCellNode().append($p('a')),
          $createTableCellNode().append(list, $p('after')),
        ),
      ),
      $p('before plain after'),
    );
}

function $allNodes(): LexicalNode[] {
  const out: LexicalNode[] = [];
  const walk = (node: LexicalNode) => {
    out.push(node);
    if ($isElementNode(node)) {
      node.getChildren().forEach(walk);
    }
  };
  walk($getRoot());
  return out;
}

/** Selects the start of the cell at [row, column]: its first text, or the cell. */
function $selectCell(row: number, column: number) {
  const table = $getRoot().getChildren().find($isTableNode)!;
  const r = table.getChildren().filter($isTableRowNode)[row];
  const cell = r.getChildren().filter($isTableCellNode)[
    column
  ] as TableCellNode;
  const text = cell.getAllTextNodes().find(t => t.isSimpleText()) as
    | TextNode
    | undefined;
  if (text !== undefined) {
    const s = $createRangeSelection();
    s.anchor.set(text.getKey(), 0, 'text');
    s.focus.set(text.getKey(), 0, 'text');
    $setSelection(s);
  } else {
    cell.selectStart();
  }
}

/** Types `char` at `offset` of the text node whose text is `text`. */
function $typeIn(text: string, offset: number, char: string) {
  const node = $allNodes().find(
    (n): n is TextNode => $isTextNode(n) && n.getTextContent() === text,
  )!;
  const s = $createRangeSelection();
  s.anchor.set(node.getKey(), offset, 'text');
  s.focus.set(node.getKey(), offset, 'text');
  $setSelection(s);
  const selection = $getSelection();
  if ($isRangeSelection(selection)) {
    selection.insertText(char);
  }
}

type Step =
  | {
      peer: string;
      op: 'insertRow' | 'insertColumn';
      cell: [number, number];
      after: boolean;
    }
  | {peer: string; op: 'type'; in: string; at: number; char: string}
  | {deliver: [string, string]};

const SCRIPT: Step[] = [
  {after: false, cell: [1, 0], op: 'insertRow', peer: 'B'},
  {at: 8, char: 'y', in: 'second number', op: 'type', peer: 'B'},
  {after: false, cell: [1, 0], op: 'insertRow', peer: 'C'},
  {after: false, cell: [0, 1], op: 'insertRow', peer: 'A'},
  {deliver: ['C', 'A']},
  {deliver: ['B', 'A']},
  {after: true, cell: [2, 0], op: 'insertColumn', peer: 'C'},
  {at: 12, char: 'x', in: 'third number', op: 'type', peer: 'A'},
  {deliver: ['C', 'B']},
  {deliver: ['A', 'C']},
  {after: false, cell: [0, 1], op: 'insertColumn', peer: 'B'},
  {at: 2, char: 'y', in: 'h1', op: 'type', peer: 'B'},
  {after: true, cell: [3, 1], op: 'insertRow', peer: 'A'},
  {after: false, cell: [3, 1], op: 'insertRow', peer: 'A'},
  {after: false, cell: [0, 0], op: 'insertRow', peer: 'B'},
  {at: 4, char: 'z', in: 'second number', op: 'type', peer: 'C'},
];

/** Then everything, in this order of channels (each channel's oldest first). */
const DELIVERIES: [string, string][] = [
  ['A', 'B'],
  ['A', 'B'],
  ['B', 'C'],
  ['B', 'C'],
  ['B', 'A'],
  ['C', 'B'],
  ['B', 'C'],
  ['A', 'C'],
  ['A', 'B'],
  ['C', 'B'],
  ['A', 'B'],
  ['B', 'C'],
  ['B', 'A'],
  ['A', 'C'],
  ['C', 'A'],
  ['C', 'A'],
  ['A', 'C'],
  ['B', 'A'],
  ['B', 'A'],
  ['B', 'C'],
];

test('v2 peers: every editor shows what its own document holds after concurrent table edits', () => {
  const queue: Message[] = [];
  const peers: Peer[] = [];
  for (const [i, name] of ['A', 'B', 'C'].entries()) {
    peers.push(new Peer(name, 1000 + i, queue, peers));
  }
  const fresh = new Peer('F', 2000, null, []);
  onTestFinished(() => [...peers, fresh].forEach(p => p.dispose()));
  const byName = (name: string) => peers.find(p => p.name === name)!;
  const deliver = ([from, to]: [string, string]) => {
    const i = queue.findIndex(m => m.from.name === from && m.to.name === to);
    const [m] = queue.splice(i, 1);
    m.to.apply(m.update);
  };
  byName('A').update($build);
  while (queue.length > 0) {
    const m = queue.shift()!;
    m.to.apply(m.update);
  }
  for (const step of SCRIPT) {
    if ('deliver' in step) {
      deliver(step.deliver);
    } else if (step.op === 'type') {
      byName(step.peer).update(() => $typeIn(step.in, step.at, step.char));
    } else {
      byName(step.peer).update(() => {
        $selectCell(...step.cell);
        if (step.op === 'insertRow') {
          $insertTableRowAtSelection(step.after);
        } else {
          $insertTableColumnAtSelection(step.after);
        }
      });
    }
  }
  for (const pair of DELIVERIES) {
    deliver(pair);
  }
  expect(queue.length).toBe(0);
  fresh.apply(encodeStateAsUpdate(byName('A').doc));
  // Before the fix, cells per row: A shows [2,3,4,3,4,0,2,4]; A's document,
  // B and C [2,3,4,3,4,2,2,4].
  expect(byName('A').rows()).toEqual(fresh.rows());
  // Every editor's whole state is what a fresh reader of the document shows.
  expect(byName('A').json()).toEqual(fresh.json());
  expect(byName('B').json()).toEqual(fresh.json());
  expect(byName('C').json()).toEqual(fresh.json());
});

/** A deterministic PRNG (mulberry32), so each seed replays the same run. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An empty table: rows that are equal to each other. */
function $buildEmpty() {
  const cell = () => $createTableCellNode().append($createParagraphNode());
  $getRoot()
    .clear()
    .append(
      $createTableNode().append(
        ...[0, 1, 2].map(() => $createTableRowNode().append(cell(), cell())),
      ),
      $p('after'),
    );
}

/**
 * In one update, removes the last cell of row `row` and appends an empty one
 * (what padding a row does after a change removed one of its cells).
 */
function $replaceLastCell(row: number) {
  const table = $getRoot().getChildren().find($isTableNode)!;
  const r = table.getChildren().filter($isTableRowNode)[row];
  const last = r.getLastChild();
  if (last !== null) {
    last.remove();
  }
  r.append($createTableCellNode().append($createParagraphNode()));
}

describe('v2 peers editing a table whose rows are equal', () => {
  test.each(Array.from({length: 60}, (_, i) => i + 1))(
    'seed %i: every editor shows its own document, and the peers agree',
    seed => {
      const random = rng(seed);
      const queue: Message[] = [];
      const peers: Peer[] = [];
      for (const [i, name] of ['A', 'B', 'C'].entries()) {
        peers.push(new Peer(name, 1000 + i, queue, peers));
      }
      const fresh = new Peer('F', 2000, null, []);
      onTestFinished(() => [...peers, fresh].forEach(p => p.dispose()));
      peers[0].update($buildEmpty);
      while (queue.length > 0) {
        const m = queue.shift()!;
        m.to.apply(m.update);
      }
      const deliverOne = () => {
        // Each channel in order; the channel picked at random.
        const pick = queue[Math.floor(random() * queue.length)];
        const i = queue.findIndex(
          m => m.from === pick.from && m.to === pick.to,
        );
        const [m] = queue.splice(i, 1);
        m.to.apply(m.update);
      };
      for (let step = 0; step < 14; step++) {
        const peer = peers[Math.floor(random() * peers.length)];
        const rows = peer.rows();
        const row = Math.floor(random() * rows.length);
        const op = random();
        peer.update(() => {
          if (op < 0.35) {
            $selectCell(row, 0);
            $insertTableRowAtSelection(random() < 0.5);
          } else if (op < 0.6) {
            $selectCell(row, 0);
            $insertTableColumnAtSelection(random() < 0.5);
          } else {
            $replaceLastCell(row);
          }
        });
        for (let k = Math.floor(random() * 3); k > 0 && queue.length > 0; k--) {
          deliverOne();
        }
      }
      while (queue.length > 0) {
        deliverOne();
      }
      fresh.apply(encodeStateAsUpdate(peers[0].doc));
      for (const p of peers) {
        expect(p.json()).toEqual(fresh.json());
      }
    },
  );
});

// Equal subtrees elsewhere: two equal blocks (of each shape) swapped, with
// the lines around them changed or not (the left, right and middle loops of
// the matching), then a peer edits the first: every editor shows the same
// whole state as a fresh reader of the document.
const SHAPES = {
  decorator: () => $create(LeafNode),
  'inline mix': () =>
    $createParagraphNode().append(
      $createTextNode('x'),
      $createLinkNode('https://example.com').append($createTextNode('link')),
      $createMarkNode(['c1']).append($createTextNode('marked')),
      $createLineBreakNode(),
      $createTextNode('tail'),
    ),
  list: () =>
    $createListNode('bullet').append(
      $createListItemNode().append($createTextNode('x')),
    ),
  'nested list': () =>
    $createListNode('number', 3).append(
      $createListItemNode().append($createTextNode('x')),
      $createListItemNode().append(
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('y')),
        ),
      ),
    ),
  paragraph: () => $p('x'),
  quote: () => $createQuoteNode().append($p('x')),
  'slot host': () => {
    const node = $create(SlottedNode).append($createTextNode('x'));
    $setSlot(node, 'title', $p('title'));
    return node;
  },
  table: () =>
    $createTableNode().append(
      $createTableRowNode().append(
        $createTableCellNode().append($p('x')),
        $createTableCellNode().append($p('y')),
      ),
    ),
  'text runs': () =>
    $createParagraphNode().append(
      $createTextNode('x'),
      $createTextNode('b').setFormat('bold'),
      $createTabNode(),
      $createHashtagNode('#tag'),
      $createCodeHighlightNode('code', 'keyword'),
    ),
};

describe('v2 peers: an equal block swapped with another', () => {
  for (const [shape, $shape] of Object.entries(SHAPES)) {
    for (const route of ['left', 'right', 'middle'] as const) {
      for (const ids of [
        [11, 22],
        [22, 11],
      ]) {
        for (const gc of [false, true]) {
          test(`${shape}, lines changed: ${route}, client ids ${ids.join('/')}, gc ${gc ? 'on' : 'off'}`, () => {
            const a = new Peer('A', ids[0], null, [], gc);
            const b = new Peer('B', ids[1], null, [], gc);
            const fresh = new Peer('F', 99, null, [], gc);
            onTestFinished(() => [a, b, fresh].forEach(p => p.dispose()));
            const sync = (to: Peer, from: Peer) =>
              to.apply(encodeStateAsUpdate(from.doc));
            a.update(() => {
              $getRoot()
                .clear()
                .append(
                  $p('lead'),
                  $shape(),
                  $p('separator'),
                  $shape(),
                  $p('tail'),
                );
            });
            sync(b, a);
            expect(b.json()).toEqual(a.json());
            // A swaps the two equal blocks (and changes the lines around
            // them, so that the matching reaches them from the right or in
            // the middle).
            a.update(() => {
              const [lead, x, mid, y, tail] = $getRoot().getChildren();
              $getRoot().clear().append(lead, y, mid, x, tail);
              if (route !== 'left' && $isElementNode(lead)) {
                lead.getAllTextNodes()[0].setTextContent('changed lead');
              }
              if (route === 'middle' && $isElementNode(tail)) {
                tail.getAllTextNodes()[0].setTextContent('changed tail');
              }
            });
            sync(b, a);
            // B edits the first of them.
            b.update(() => {
              const node = $getRoot().getChildAtIndex(1)!;
              if (!$isElementNode(node)) {
                node.replace($p('R'));
                return;
              }
              const text = node.getAllTextNodes()[0];
              if (text === undefined) {
                // (A decorator, held by the paragraph made around it.)
                node.getFirstChildOrThrow().replace($createTextNode('R'));
                return;
              }
              text.setTextContent(text.getTextContent() + 'R');
              const title = $getSlot(node, 'title');
              if ($isElementNode(title)) {
                title.getAllTextNodes()[0].setTextContent('titleR');
              }
            });
            sync(a, b);
            sync(fresh, a);
            expect(a.json()).toEqual(b.json());
            expect(a.json()).toEqual(fresh.json());
          });
        }
      }
    }
  }
});

test('v2 peers: a text run made again with the same text, between two changed links, keeps its mapping', () => {
  const a = new Peer('A', 1, null, []);
  const b = new Peer('B', 2, null, []);
  const fresh = new Peer('F', 99, null, []);
  onTestFinished(() => [a, b, fresh].forEach(p => p.dispose()));
  const sync = (to: Peer, from: Peer) =>
    to.apply(encodeStateAsUpdate(from.doc));
  a.update(() => {
    $getRoot()
      .clear()
      .append(
        $createParagraphNode().append(
          $createLinkNode('https://a.test').append($createTextNode('a')),
          $createTextNode('middle'),
          $createLinkNode('https://c.test').append($createTextNode('c')),
        ),
      );
  });
  sync(b, a);
  // In one update, A changes both links and makes "middle" again (the same
  // text in a new node), so the matching reaches it in the middle.
  a.update(() => {
    const [first, middle, last] = (
      $getRoot().getFirstChild() as ElementNode
    ).getChildren();
    (first as LinkNode).setURL('https://a2.test');
    (last as LinkNode).setURL('https://c2.test');
    middle.replace($createTextNode('middle'));
  });
  sync(b, a);
  // B types into "middle".
  b.update(() => {
    const middle = $getRoot()
      .getAllTextNodes()
      .find(t => t.getTextContent() === 'middle')!;
    middle.setTextContent('middleX');
  });
  sync(a, b);
  sync(fresh, a);
  expect(a.json()).toEqual(b.json());
  expect(a.json()).toEqual(fresh.json());
});
