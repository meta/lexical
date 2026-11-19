/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A column insert concurrent with two row inserts leaves two short rows, one
// per author. Each peer pads the short rows it created once it has the
// others' changes (a repair after remote changes, owned so that no two peers
// pad the same row; reported downstream). The table's row transform pads
// only the row that changed: padding every short row, as marking the table
// dirty did, made peers pad each other's rows at the same time, and the
// duplicated cells made the other rows short again, without end.

import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNodeWithDimensions,
  $insertTableColumnAtSelection,
  $insertTableRowAtSelection,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
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
  $createParagraphNode,
  $getRoot,
  $isElementNode,
  COLLABORATION_TAG,
  configExtension,
  type LexicalEditor,
  SKIP_COLLAB_TAG,
} from 'lexical';
import {describe, expect, test} from 'vitest';
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

class Peer {
  readonly doc = new Doc({gc: false});
  readonly editor: LexicalEditor;
  readonly binding: BindingV2;

  constructor(
    name: string,
    readonly network: Message[],
    readonly peers: Peer[],
  ) {
    this.doc.clientID = 1000 + name.charCodeAt(0);
    const editor = buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [
        RichTextExtension,
        configExtension(TableExtension, {hasHorizontalScroll: false}),
      ],
      name: `[table-${name}]`,
      onError: e => {
        throw e;
      },
    });
    this.editor = editor;
    const binding = createBindingV2__EXPERIMENTAL(
      editor,
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
    editor.registerUpdateListener(
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
    // After a remote change, pad the short rows this peer created.
    editor.registerUpdateListener(({tags}) => {
      if (!tags.has(COLLABORATION_TAG)) {
        return;
      }
      editor.update(
        () => {
          for (const table of $getRoot().getChildren().filter($isTableNode)) {
            const rows = table.getChildren();
            const width = Math.max(
              ...rows.map(row =>
                $isElementNode(row) ? row.getChildrenSize() : 0,
              ),
            );
            for (const row of rows) {
              if (!$isTableRowNode(row) || row.getChildrenSize() >= width) {
                continue;
              }
              const item = binding.mapping.getSharedType(row)?._item;
              if (!item || item.id.client !== this.doc.clientID) {
                continue;
              }
              for (let i = row.getChildrenSize(); i < width; i++) {
                row.append(
                  $createTableCellNode().append($createParagraphNode()),
                );
              }
            }
          }
        },
        {discrete: true},
      );
    });
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) {
        return;
      }
      for (const peer of this.peers) {
        if (peer !== this) {
          this.network.push({from: this, to: peer, update});
        }
      }
    });
  }

  update(fn: () => void) {
    this.editor.update(fn, {discrete: true});
  }

  apply(update: Uint8Array) {
    applyUpdate(this.doc, update, REMOTE);
    this.editor.read(() => {});
  }

  cellsPerRow(): string {
    return this.editor.read(() => {
      const table = $getRoot().getChildren().find($isTableNode);
      return table === undefined
        ? ''
        : table
            .getChildren()
            .map(row =>
              $isElementNode(row)
                ? row.getChildren().filter($isTableCellNode).length
                : 0,
            )
            .join(',');
    });
  }
}

function $selectCell(row: number, col: number) {
  const table = $getRoot().getChildren().find($isTableNode)!;
  const r = table.getChildAtIndex(row);
  const cell = $isElementNode(r) ? r.getChildAtIndex(col) : null;
  if (!$isElementNode(cell)) {
    throw new Error('no cell');
  }
  cell.selectStart();
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A inserts a column while B (and C) insert a row; the messages are then
 * delivered per channel in order, the channels in an order `interleaving`
 * draws, until none is left (at most 500).
 */
function run(interleaving: number, count: 2 | 3) {
  const network: Message[] = [];
  const peers: Peer[] = [];
  const all = ['A', 'B', 'C']
    .slice(0, count)
    .map(name => new Peer(name, network, peers));
  peers.push(...all);
  const [a, b, c] = all;
  a.update(() => {
    $getRoot()
      .clear()
      .append($createTableNodeWithDimensions(2, 2, false));
  });
  const seed = encodeStateAsUpdate(a.doc);
  for (const peer of all.slice(1)) {
    peer.apply(seed);
  }
  network.length = 0;
  a.update(() => {
    $selectCell(0, 1);
    $insertTableColumnAtSelection(true);
  });
  b.update(() => {
    $selectCell(1, 0);
    $insertTableRowAtSelection(true);
  });
  if (c !== undefined) {
    c.update(() => {
      $selectCell(0, 0);
      $insertTableRowAtSelection(true);
    });
  }
  const random = mulberry32(interleaving);
  let delivered = 0;
  while (network.length > 0 && delivered < 500) {
    const pick =
      network[interleaving === 0 ? 0 : Math.floor(random() * network.length)];
    const i = network.findIndex(m => m.to === pick.to && m.from === pick.from);
    const [{to, update}] = network.splice(i, 1);
    to.apply(update);
    delivered++;
  }
  return {left: network.length, shapes: peers.map(p => p.cellsPerRow())};
}

const INTERLEAVINGS = Array.from({length: 40}, (_, i) => i);

describe('v2 peers that pad the table rows they created after remote changes', () => {
  test.each(INTERLEAVINGS)(
    'a column insert concurrent with two row inserts settles with 3 cells in every row (interleaving %i)',
    interleaving => {
      expect(run(interleaving, 3)).toEqual({
        left: 0,
        shapes: ['3,3,3,3', '3,3,3,3', '3,3,3,3'],
      });
    },
  );

  test.each(INTERLEAVINGS)(
    'two peers: a column insert concurrent with a row insert settles with 3 cells in every row (interleaving %i)',
    interleaving => {
      expect(run(interleaving, 2)).toEqual({
        left: 0,
        shapes: ['3,3,3', '3,3,3'],
      });
    },
  );
});
