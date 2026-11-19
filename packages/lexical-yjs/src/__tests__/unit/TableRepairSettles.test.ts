/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Three @lexical/yjs clients (v1 and v2, wired like the React collaboration
// plugin) whose app pads the short table rows the client itself created
// after every remote change (an owner-gated row repair; the owner of a row
// is the client that created its shared type). They make 12 edits from the
// core packages (list type and start, a paragraph, table row and column
// inserts and deletes, a deleted character, bold) with a few messages
// delivered in between, then every message is delivered, oldest first, up
// to 400 deliveries. The clients should go quiet. When a change to one row
// padded the whole table (or that row up to the table's grid width, spans
// counted, where the app counts cells), each client padded again the row
// the other's repair had just padded, and they kept sending each other row
// repairs (17 messages still queued after 400 deliveries, on v1 and on v2);
// the same script without the row repair goes quiet.

import {buildEditorFromExtensions} from '@lexical/extension';
import {$createLinkNode, LinkNode} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  $isListNode,
  ListExtension,
  type ListNode,
  type ListType,
} from '@lexical/list';
import {$createMarkNode, MarkNode} from '@lexical/mark';
import {
  $createHeadingNode,
  $createQuoteNode,
  HeadingNode,
  QuoteNode,
} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $deleteTableColumnAtSelection,
  $deleteTableRowAtSelection,
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
  createBinding,
  createBindingV2__EXPERIMENTAL,
  type Provider,
  syncLexicalUpdateToYjs,
  syncLexicalUpdateToYjsV2__EXPERIMENTAL,
  syncYjsChangesToLexical,
  syncYjsChangesToLexicalV2__EXPERIMENTAL,
} from '@lexical/yjs';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COLLABORATION_TAG,
  type LexicalEditor,
  type LexicalNode,
  SKIP_COLLAB_TAG,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';
import {applyUpdate, Doc, type Item, UndoManager, type XmlElement} from 'yjs';

type Kind = 'yjs-v1' | 'yjs-v2';
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

type Message = {from: Client; to: Client; update: Uint8Array};

class Client {
  readonly doc = new Doc({gc: false});
  readonly editor: LexicalEditor;
  readonly errors: string[] = [];
  /** The shared type of a row, to tell which rows this client created. */
  private readonly sharedTypeOf: (row: LexicalNode) => Item | null;

  constructor(
    readonly name: string,
    kind: Kind,
    clientID: number,
    queue: Message[],
    clients: Client[],
    repair: boolean,
  ) {
    this.doc.clientID = clientID;
    const editor = buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [ListExtension, TableExtension],
      name: `[repair-${name}]`,
      nodes: [HeadingNode, QuoteNode, LinkNode, MarkNode],
      onError: e => {
        throw e;
      },
    });
    this.editor = editor;
    const docMap = new Map([['main', this.doc]]);
    if (kind === 'yjs-v1') {
      const binding = createBinding(editor, provider, 'main', this.doc, docMap);
      binding.root.getSharedType().observeDeep(((
        events: never,
        transaction: {origin: unknown},
      ) => {
        if (transaction.origin !== binding) {
          syncYjsChangesToLexical(
            binding,
            provider,
            events,
            transaction.origin instanceof UndoManager,
            () => {},
          );
        }
      }) as never);
      editor.registerUpdateListener(p => {
        if (!p.tags.has(SKIP_COLLAB_TAG)) {
          syncLexicalUpdateToYjs(
            binding,
            provider,
            p.prevEditorState,
            p.editorState,
            p.dirtyElements,
            p.dirtyLeaves,
            p.normalizedNodes,
            p.tags,
          );
        }
      });
      this.sharedTypeOf = row =>
        (
          binding.collabNodeMap.get(row.getKey()) as unknown as
            | {_xmlText?: {_item: Item | null}}
            | undefined
        )?._xmlText?._item ?? null;
    } else {
      const binding = createBindingV2__EXPERIMENTAL(
        editor,
        'main',
        this.doc,
        docMap,
      );
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
      editor.registerUpdateListener(p => {
        if (!p.tags.has(SKIP_COLLAB_TAG)) {
          syncLexicalUpdateToYjsV2__EXPERIMENTAL(
            binding,
            provider,
            p.prevEditorState,
            p.editorState,
            p.dirtyElements,
            p.dirtyLeaves,
            p.normalizedNodes,
            p.tags,
          );
        }
      });
      editor.read(() => {});
      this.sharedTypeOf = row =>
        (
          binding.mapping.getSharedType(row as never) as unknown as
            | {_item: Item | null}
            | undefined
        )?._item ?? null;
    }
    if (repair) {
      // After every remote change, pad the short rows this client created.
      editor.registerUpdateListener(({tags}) => {
        if (tags.has(COLLABORATION_TAG)) {
          editor.update(() => this.$padOwnRows(), {discrete: true});
        }
      });
    }
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE) {
        for (const to of clients) {
          if (to !== this) {
            queue.push({from: this, to, update});
          }
        }
      }
    });
  }

  private $padOwnRows() {
    const walk = (node: LexicalNode) => {
      if ($isTableNode(node)) {
        const rows = node.getChildren().filter($isTableRowNode);
        const width = Math.max(0, ...rows.map(r => r.getChildrenSize()));
        for (const row of rows) {
          const item = this.sharedTypeOf(row);
          if (item !== null && item.id.client === this.doc.clientID) {
            for (let j = row.getChildrenSize(); j < width; j++) {
              row.append($createTableCellNode().append($createParagraphNode()));
            }
          }
        }
      }
      if ($isElementNode(node)) {
        node.getChildren().forEach(walk);
      }
    };
    walk($getRoot());
  }

  flush() {
    for (let i = 0; i < 20 && this.editor._pendingEditorState !== null; i++) {
      this.editor.read(() => {});
    }
  }

  private guard(fn: () => void) {
    try {
      fn();
      this.flush();
    } catch (error) {
      this.errors.push(String(error).split('.')[0]);
    }
  }

  update(fn: () => void) {
    this.guard(() => this.editor.update(fn, {discrete: true}));
  }

  apply(update: Uint8Array) {
    this.guard(() => applyUpdate(this.doc, update, REMOTE));
  }
}

const $t = (text: string) => $createTextNode(text);
const $p = (...children: LexicalNode[]) =>
  $createParagraphNode().append(...children);

function $list(type: ListType, start = 1, nested = false): ListNode {
  const item = (text: string) =>
    $createListItemNode(
      type === 'check' ? text.length % 2 === 0 : undefined,
    ).append($t(text));
  const list = $createListNode(type, start).append(
    item(`first ${type}`),
    item(`second ${type}`),
    item(`third ${type}`),
  );
  if (nested) {
    list.splice(2, 0, [
      $createListItemNode().append(
        $createListNode(type, 1).append(item('inner one'), item('inner two')),
      ),
    ]);
  }
  return list;
}

function $cell(text: string, header = false, colSpan = 1) {
  return $createTableCellNode(
    header ? TableCellHeaderStates.ROW : TableCellHeaderStates.NO_STATUS,
    colSpan,
  ).append($p($t(text)));
}

/** Two tables (one with merged cells), lists, and a few text blocks. */
function $build() {
  const span = $cell('spans two rows');
  span.setRowSpan(2);
  $getRoot()
    .clear()
    .append(
      $createTableNode().append(
        $createTableRowNode().append($cell('h1', true), $cell('h2', true)),
        $createTableRowNode().append(
          $cell('a'),
          $createTableCellNode().append($list('number', 3), $p($t('after'))),
        ),
      ),
      $createTableNode().append(
        $createTableRowNode().append(
          $cell('wide header', true, 2),
          $cell('h3'),
        ),
        $createTableRowNode().append(span, $cell('b'), $cell('c')),
        $createTableRowNode().append(
          $cell('d'),
          $createTableCellNode().append($list('bullet')),
        ),
      ),
      $list('number', 5),
      $list('check', 1, true),
      $p(
        $t('bold start').setFormat('bold').setStyle('color: red'),
        $t(' plain'),
      ),
      $p($t('before plain after')),
      $p(
        $t('before '),
        $createMarkNode(['comment-1']).append($t('commented')),
        $t(' after'),
      ),
      $p(
        $t('before '),
        $createLinkNode('https://example.com').append($t('a link')),
        $t(' after'),
      ),
      $createQuoteNode().append($t('quoted')),
      $createHeadingNode('h2').append($t('Heading')),
    );
}

/** Every node in document order that passes `test`. */
function $all<T extends LexicalNode>(keep: (n: LexicalNode) => boolean): T[] {
  const out: T[] = [];
  const walk = (node: LexicalNode) => {
    if (keep(node)) {
      out.push(node as T);
    }
    if ($isElementNode(node)) {
      node.getChildren().forEach(walk);
    }
  };
  walk($getRoot());
  return out;
}

const $texts = () =>
  $all<TextNode>(n => $isTextNode(n) && (n as TextNode).isSimpleText());

/** The `index`th simple text node; checks it holds `content`. */
function $text(index: number, content: string): TextNode {
  const node = $texts()[index];
  expect(node.getTextContent()).toBe(content);
  return node;
}

function $select(node: TextNode, from: number, to = from) {
  const s = $createRangeSelection();
  s.anchor.set(node.getKey(), from, 'text');
  s.focus.set(node.getKey(), to, 'text');
  $setSelection(s);
}

/** Selects the start of the `index`th table cell, as a click there would. */
function $selectCell(index: number) {
  const cell = $all<TableCellNode>($isTableCellNode)[index];
  const text = cell.getAllTextNodes().find(t => t.isSimpleText());
  if (text !== undefined) {
    $select(text, 0);
  } else {
    cell.selectStart();
  }
}

type Step =
  | {deliver: [string, string]}
  | ({peer: string} & (
      | {op: 'listType'; list: number; type: ListType}
      | {op: 'listStart'; list: number; start: number}
      | {op: 'insertParagraph'; text: number; content: string}
      | {op: 'deleteChar'; text: number; content: string; at: number}
      | {op: 'bold'; text: number; content: string; from: number; to: number}
      | {
          op: 'tableInsertRow' | 'tableInsertColumn';
          cell: number;
          after: boolean;
        }
      | {op: 'tableDeleteRow' | 'tableDeleteColumn'; cell: number}
    ));

const SCRIPT: Step[] = [
  {list: 2, op: 'listType', peer: 'B', type: 'check'},
  {content: 'c', op: 'insertParagraph', peer: 'B', text: 11},
  {after: false, cell: 1, op: 'tableInsertRow', peer: 'A'},
  {after: false, cell: 10, op: 'tableInsertRow', peer: 'B'},
  {list: 0, op: 'listStart', peer: 'C', start: 2},
  {deliver: ['B', 'C']},
  {deliver: ['B', 'A']},
  {at: 1, content: 'quoted', op: 'deleteChar', peer: 'B', text: 34},
  {content: 'first number', from: 10, op: 'bold', peer: 'B', text: 17, to: 11},
  {cell: 11, op: 'tableDeleteColumn', peer: 'B'},
  {after: false, cell: 6, op: 'tableInsertColumn', peer: 'C'},
  {cell: 3, op: 'tableDeleteColumn', peer: 'A'},
  {deliver: ['B', 'A']},
  {deliver: ['A', 'B']},
  {after: false, cell: 8, op: 'tableInsertColumn', peer: 'A'},
  {deliver: ['C', 'B']},
  {at: 0, content: 'second bullet', op: 'deleteChar', peer: 'B', text: 13},
  {deliver: ['C', 'A']},
  {deliver: ['B', 'C']},
];

function run(kind: Kind, repair: boolean) {
  const queue: Message[] = [];
  const clients: Client[] = [];
  for (const [i, name] of ['A', 'B', 'C'].entries()) {
    clients.push(new Client(name, kind, 1000 + i, queue, clients, repair));
  }
  const byName = (name: string) => clients.find(c => c.name === name)!;
  const deliverOldest = (from: string, to: string) => {
    const i = queue.findIndex(m => m.from.name === from && m.to.name === to);
    const [m] = queue.splice(i, 1);
    m.to.apply(m.update);
  };
  const drain = (cap: number) => {
    let delivered = 0;
    while (queue.length > 0 && delivered < cap) {
      const m = queue.shift()!;
      m.to.apply(m.update);
      delivered++;
    }
    return delivered;
  };
  byName('A').update($build);
  drain(400);
  expect(queue.length).toBe(0);
  for (const step of SCRIPT) {
    if ('deliver' in step) {
      deliverOldest(...step.deliver);
      continue;
    }
    byName(step.peer).update(() => {
      switch (step.op) {
        case 'listType':
          $all<ListNode>($isListNode)[step.list].setListType(step.type);
          break;
        case 'listStart':
          $all<ListNode>($isListNode)[step.list].setStart(step.start);
          break;
        case 'insertParagraph':
          $text(step.text, step.content)
            .getTopLevelElementOrThrow()
            .insertAfter($p($t('new line')));
          break;
        case 'deleteChar':
          $text(step.text, step.content).spliceText(step.at, 1, '');
          break;
        case 'bold': {
          $select($text(step.text, step.content), step.from, step.to);
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.formatText('bold');
          }
          break;
        }
        case 'tableInsertRow':
          $selectCell(step.cell);
          $insertTableRowAtSelection(step.after);
          break;
        case 'tableInsertColumn':
          $selectCell(step.cell);
          $insertTableColumnAtSelection(step.after);
          break;
        case 'tableDeleteRow':
          $selectCell(step.cell);
          $deleteTableRowAtSelection();
          break;
        case 'tableDeleteColumn':
          $selectCell(step.cell);
          $deleteTableColumnAtSelection();
          break;
      }
    });
  }
  const delivered = drain(400);
  return {
    delivered,
    errors: [...new Set(clients.flatMap(c => c.errors))],
    left: queue.length,
  };
}

for (const kind of ['yjs-v1', 'yjs-v2'] as const) {
  test(`${kind}: clients with an owner-gated row repair go quiet after concurrent edits`, () => {
    // #9539 72ecb3ca, v1 and v2: messages still queued after 400
    // deliveries, and "update listeners are endlessly enqueueing more
    // updates" thrown while applying them.
    const r = run(kind, true);
    expect({errors: r.errors, left: r.left}).toEqual({errors: [], left: 0});
  });
  test(`${kind}, control: the same edits without the row repair go quiet`, () => {
    const r = run(kind, false);
    expect({errors: r.errors, left: r.left}).toEqual({errors: [], left: 0});
  });
}
