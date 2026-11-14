/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Two v2 peers with the stock TableExtension and no app code (#9453). A
// column insert concurrent with a row insert leaves the new row short; the
// short row is its author's to pad (#9539), so later edits elsewhere in the
// table, even concurrent ones, must not pad it: two peers padding the same
// row at once duplicate cells, which makes the other rows short in turn. The
// HTML each peer exports is a rectangle all the same.

import {buildEditorFromExtensions} from '@lexical/extension';
import {$generateHtmlFromNodes} from '@lexical/html';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createTableNodeWithDimensions,
  $insertTableColumnAtSelection,
  $insertTableRowAtSelection,
  $isTableCellNode,
  $isTableNode,
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
  $getRoot,
  $getSelection,
  $isElementNode,
  configExtension,
  type LexicalEditor,
  SKIP_COLLAB_TAG,
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

class Peer {
  readonly doc = new Doc({gc: false});
  readonly editor: LexicalEditor;
  readonly binding: BindingV2;
  /** Updates made here and not yet delivered to the other peer. */
  outbox: Uint8Array[] = [];

  constructor(name: string) {
    this.doc.clientID = 1000 + name.charCodeAt(0);
    const editor = buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [
        RichTextExtension,
        configExtension(TableExtension, {hasHorizontalScroll: false}),
      ],
      name: `[ragged-table-${name}]`,
      onError: e => {
        throw e;
      },
    });
    onTestFinished(() => editor.dispose());
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
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE) {
        this.outbox.push(update);
      }
    });
  }

  update(fn: () => void) {
    this.editor.update(fn, {discrete: true});
  }

  /** Delivers this peer's pending updates to `to`. */
  sendTo(to: Peer) {
    const updates = this.outbox;
    this.outbox = [];
    for (const update of updates) {
      applyUpdate(to.doc, update, REMOTE);
    }
    to.editor.read(() => {});
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

  text(): string {
    return this.editor.read(() => $getRoot().getTextContent());
  }

  exportedCellsPerRow(): string {
    const html = this.editor.read(() => $generateHtmlFromNodes(this.editor));
    const container = document.createElement('div');
    container.innerHTML = html;
    return Array.from(container.querySelectorAll('tr'), tr => tr.cells.length)
      .map(String)
      .join(',');
  }
}

function $typeInCell(row: number, col: number, text: string) {
  const table = $getRoot().getChildren().find($isTableNode)!;
  const r = table.getChildAtIndex(row);
  const cell = $isElementNode(r) ? r.getChildAtIndex(col) : null;
  if (!$isElementNode(cell)) {
    throw new Error('no cell');
  }
  cell.selectEnd();
  $getSelection()!.insertText(text);
}

/**
 * Delivers updates both ways until neither peer has any left. A peer that
 * kept answering the other's changes with changes of its own (two peers
 * padding the same rows) would not settle, which fails here.
 */
function exchange(a: Peer, b: Peer) {
  for (let round = 0; round < 10; round++) {
    if (a.outbox.length === 0 && b.outbox.length === 0) {
      return;
    }
    a.sendTo(b);
    b.sendTo(a);
  }
  throw new Error('the peers did not settle in 10 rounds');
}

/** Two peers sharing a 2x2 table; A inserts a column while B inserts a row. */
function raggedPeers(): [Peer, Peer] {
  const a = new Peer('A');
  const b = new Peer('B');
  a.update(() => {
    $getRoot()
      .clear()
      .append($createTableNodeWithDimensions(2, 2, false));
  });
  applyUpdate(b.doc, encodeStateAsUpdate(a.doc), REMOTE);
  b.editor.read(() => {});
  a.outbox = [];
  a.update(() => {
    const table = $getRoot().getChildren().find($isTableNode)!;
    const row = table.getChildAtIndex(0);
    if ($isElementNode(row)) {
      row.getChildAtIndex(1)?.selectStart();
    }
    $insertTableColumnAtSelection(true);
  });
  b.update(() => {
    const table = $getRoot().getChildren().find($isTableNode)!;
    const row = table.getChildAtIndex(1);
    if ($isElementNode(row)) {
      row.getChildAtIndex(0)?.selectStart();
    }
    $insertTableRowAtSelection(true);
  });
  exchange(a, b);
  return [a, b];
}

describe('a table made ragged by concurrent inserts, between two v2 peers (#9453)', () => {
  test('stays as its authors left it while both peers type in it', () => {
    const [a, b] = raggedPeers();
    expect([a.cellsPerRow(), b.cellsPerRow()]).toEqual(['3,3,2', '3,3,2']);

    // Both type in cell (0,0) at once.
    a.update(() => $typeInCell(0, 0, 'a'));
    b.update(() => $typeInCell(0, 0, 'b'));
    exchange(a, b);
    expect([a.cellsPerRow(), b.cellsPerRow()]).toEqual(['3,3,2', '3,3,2']);

    // One more keystroke.
    a.update(() => $typeInCell(0, 0, 'c'));
    exchange(a, b);
    expect([a.cellsPerRow(), b.cellsPerRow()]).toEqual(['3,3,2', '3,3,2']);
    expect(a.text()).toBe(b.text());
    expect(a.outbox).toEqual([]);
    expect(b.outbox).toEqual([]);
  });

  test('exports a rectangle from both peers', () => {
    const [a, b] = raggedPeers();
    a.update(() => $typeInCell(0, 0, 'a'));
    b.update(() => $typeInCell(0, 0, 'b'));
    exchange(a, b);
    expect([a.exportedCellsPerRow(), b.exportedCellsPerRow()]).toEqual([
      '3,3,3',
      '3,3,3',
    ]);
    // Exporting changed neither document.
    expect([a.cellsPerRow(), b.cellsPerRow()]).toEqual(['3,3,2', '3,3,2']);
    expect([a.outbox, b.outbox]).toEqual([[], []]);
  });
});
