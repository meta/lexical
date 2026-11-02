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
// others' changes (an app's repair after remote changes, owned so that no
// two peers pad the same row). Its update runs the table's transforms: they
// must pad only the row that changed. Padding every short row, as marking
// the table dirty did, made peers pad each other's rows at the same time,
// and the duplicated cells made the other rows short again (reported
// downstream with the v2 binding; see lexical-yjs TableRowRepairCollab).

import {
  buildEditorFromExtensions,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
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
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  configExtension,
  defineExtension,
  type NodeKey,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YCollabExtension, type YDoc} from '../..';

type Message = {from: Peer; to: Peer; update: Uint8Array};

const REMOTE = 'remote';

class Peer {
  readonly doc: YDoc = createYDoc();
  readonly editor: LexicalEditorWithDispose;
  /** The rows this peer inserted. */
  readonly own = new Set<NodeKey>();

  constructor(
    name: string,
    readonly network: Message[],
    readonly peers: Peer[],
  ) {
    this.doc.clientID = 1000 + name.charCodeAt(0);
    this.editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        dependencies: [
          RichTextExtension,
          configExtension(TableExtension, {hasHorizontalScroll: false}),
          configExtension(YCollabExtension, {
            doc: this.doc,
            schemaVersion: 1,
            synced: true,
          }),
        ],
        name: `[table-${name}]`,
        onError: e => {
          throw e;
        },
      }),
    );
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

  /** Apply a remote update, then pad the short rows this peer inserted. */
  apply(update: Uint8Array) {
    Y.applyUpdate(this.doc, update, REMOTE);
    this.editor.read(() => {});
    this.update(() => {
      const table = $getRoot().getChildren().find($isTableNode);
      if (table === undefined) {
        return;
      }
      const rows = table.getChildren();
      const width = Math.max(
        ...rows.map(row => ($isElementNode(row) ? row.getChildrenSize() : 0)),
      );
      for (const key of this.own) {
        const row = $getNodeByKey(key);
        if ($isTableRowNode(row) && row.isAttached()) {
          for (let i = row.getChildrenSize(); i < width; i++) {
            row.append($createTableCellNode().append($createParagraphNode()));
          }
        }
      }
    });
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

function run(interleaving: number) {
  const network: Message[] = [];
  const peers: Peer[] = [];
  const all = ['A', 'B', 'C'].map(name => new Peer(name, network, peers));
  peers.push(...all);
  const [a, b, c] = all;
  a.update(() => {
    $getRoot()
      .clear()
      .append($createTableNodeWithDimensions(2, 2, false));
  });
  for (const peer of [b, c]) {
    Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(a.doc), REMOTE);
    peer.editor.read(() => {});
  }
  network.length = 0;
  a.update(() => {
    $selectCell(0, 1);
    $insertTableColumnAtSelection(true);
  });
  b.update(() => {
    $selectCell(1, 0);
    const row = $insertTableRowAtSelection(true);
    if (row !== null) {
      b.own.add(row.getKey());
    }
  });
  c.update(() => {
    $selectCell(0, 0);
    const row = $insertTableRowAtSelection(true);
    if (row !== null) {
      c.own.add(row.getKey());
    }
  });
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
  const result = {
    left: network.length,
    shapes: peers.map(p => p.cellsPerRow()),
  };
  for (const peer of all) {
    peer.editor.dispose();
  }
  return result;
}

describe('@lexical/y peers that pad the table rows they created after remote changes', () => {
  test.each(Array.from({length: 40}, (_, i) => i))(
    'a column insert concurrent with two row inserts settles with 3 cells in every row (interleaving %i)',
    interleaving => {
      expect(run(interleaving)).toEqual({
        left: 0,
        shapes: ['3,3,3,3', '3,3,3,3', '3,3,3,3'],
      });
    },
  );
});
