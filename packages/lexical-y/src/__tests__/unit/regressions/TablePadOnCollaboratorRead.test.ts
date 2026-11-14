/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A collaborator's change is read while the editor's DOM holds a change it
// has not processed yet (here, a decorator rendering into its element, as
// React renders decorators). Lexical reverts such changes before the read
// commits, in an update that joins the read's pending state. That update ran
// node transforms, which the read itself skips, over everything the read
// changed: the table transform padded the rows a concurrent column delete
// and row insert left ragged, in this editor only. Its document lacks the
// padding cells, so words typed into them never reached anyone.

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $deleteTableColumnAtSelection,
  $insertTableRowAtSelection,
  TableCellHeaderStates,
  type TableCellNode,
  TableExtension,
  type TableNode,
  type TableRowNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getEditor,
  $getRoot,
  $getSelection,
  configExtension,
  DecoratorNode,
  defineExtension,
  type ElementNode,
  type NodeKey,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YCollabExtension, type YDoc} from '../../..';
import {readYState} from '../../../headless';
import {flush, WITH_GC} from '../../utils/harness';

class BadgeNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_badge', {extends: DecoratorNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('span');
  }
  updateDOM(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

const $cell = (text: string, header: boolean, colSpan = 1) =>
  $createTableCellNode(
    header ? TableCellHeaderStates.ROW : TableCellHeaderStates.NO_STATUS,
    colSpan,
  ).append($createParagraphNode().append($createTextNode(text)));

const $table = () =>
  $getRoot()
    .getChildren()
    .find((node): node is TableNode => node.getType() === 'table')!;

const $cellAt = (row: number, column: number) =>
  ($table().getChildAtIndex(row) as TableRowNode).getChildAtIndex(
    column,
  ) as TableCellNode;

/** The caret at the end of the first paragraph of `cell`. */
const $selectCellEnd = (cell: TableCellNode) =>
  (cell.getFirstChildOrThrow() as ElementNode).selectEnd();

type Peer = {
  doc: YDoc;
  editor: ReturnType<typeof buildEditorFromExtensions>;
  root: HTMLElement;
  /** Updates this peer made while the network was down. */
  outbox: Uint8Array[];
};

function createPeer(clientID: number): Peer {
  const doc = createYDoc(null, {gc: WITH_GC});
  doc.clientID = clientID;
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        RichTextExtension,
        configExtension(TableExtension, {hasHorizontalScroll: false}),
        configExtension(YCollabExtension, {doc, schemaVersion: 1}),
      ],
      name: 'table-pad-on-collaborator-read',
      nodes: () => [BadgeNode],
      onError: (e: Error) => {
        throw e;
      },
    }),
  );
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  editor.setRootElement(root);
  const peer: Peer = {doc, editor, outbox: [], root};
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'network') {
      peer.outbox.push(update);
    }
  });
  return peer;
}

/** What `peer`'s editor shows, as JSON. */
const shown = (peer: Peer) =>
  JSON.stringify(peer.editor.getEditorState().toJSON());

/** What `peer`'s document stores, read fresh, as JSON. */
const stored = (peer: Peer) =>
  JSON.stringify(
    readYState(
      Y.encodeStateAsUpdate(peer.doc),
      {
        extensions: [
          configExtension(TableExtension, {hasHorizontalScroll: false}),
        ],
        nodes: [BadgeNode],
        schemaVersion: 1,
      },
      () => $getEditor().getEditorState().toJSON(),
    ),
  );

/** Each row's cell count, as `peer`'s editor shows the table. */
const widths = (peer: Peer) =>
  peer.editor.read(() =>
    $table()
      .getChildren()
      .map(row => (row as ElementNode).getChildrenSize()),
  );

/**
 * Render the badge into its element, as a decorator renders, which the
 * editor's mutation observer records.
 */
function renderBadge(peer: Peer, key: NodeKey) {
  peer.editor.getElementByKey(key)!.textContent = 'rendered';
}

/** Deliver what each peer sent to the other. */
function exchange(a: Peer, b: Peer, badges: Map<Peer, NodeKey>) {
  for (const [from, to] of [
    [a, b],
    [b, a],
  ]) {
    // The receiver's DOM holds a change it has not processed when the
    // update arrives.
    renderBadge(to, badges.get(to)!);
    for (const update of from.outbox.splice(0)) {
      Y.applyUpdate(to.doc, update, 'network');
    }
  }
}

test('a table a collaborator left ragged is shown as stored, and words typed into it reach every client', async () => {
  const a = createPeer(1);
  const b = createPeer(2);
  a.editor.update(
    () => {
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append($create(BadgeNode)),
          $createTableNode()
            .setColWidths([120, 80, 100])
            .append(
              $createTableRowNode().append(
                $cell('h0', true),
                $cell('h1', true),
                $cell('h2', true),
              ),
              $createTableRowNode().append(
                $cell('merged', false, 2),
                $cell('r1', false),
              ),
              $createTableRowNode().append(
                $cell('a', false),
                $cell('b', false),
                $cell('c', false),
              ),
            ),
          $createParagraphNode(),
        );
    },
    {discrete: true},
  );
  getExtensionDependencyFromEditor(
    a.editor,
    YCollabExtension,
  ).output.binding.initialize();
  await flush();
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'network');
  a.outbox.length = 0;
  await flush();
  const badgeKey = (peer: Peer) =>
    peer.editor.read(() =>
      ($getRoot().getFirstChildOrThrow() as ElementNode)
        .getFirstChildOrThrow()
        .getKey(),
    );
  const badges = new Map([
    [a, badgeKey(a)],
    [b, badgeKey(b)],
  ]);
  // Concurrently: A deletes the middle column, B adds a row after the
  // header row.
  a.editor.update(
    () => {
      $selectCellEnd($cellAt(2, 1));
      $deleteTableColumnAtSelection();
    },
    {discrete: true},
  );
  b.editor.update(
    () => {
      $selectCellEnd($cellAt(0, 0));
      $insertTableRowAtSelection(true);
    },
    {discrete: true},
  );
  exchange(a, b, badges);
  await flush();
  // Ragged, as stored (D55): the new row has B's three cells.
  for (const peer of [a, b]) {
    expect(widths(peer)).toEqual([2, 3, 2, 2]);
    expect(shown(peer)).toBe(stored(peer));
  }
  // Each types a word at the end of every row.
  for (const [peer, word] of [
    [a, 'AA'],
    [b, 'BB'],
  ] as const) {
    const rows = peer.editor.read(() => $table().getChildrenSize());
    for (let row = 0; row < rows; row++) {
      peer.editor.update(
        () => {
          $selectCellEnd(
            (
              $table().getChildAtIndex(row) as TableRowNode
            ).getLastChildOrThrow() as TableCellNode,
          );
          $getSelection()!.insertText(` ${word}${row}`);
        },
        {discrete: true},
      );
    }
  }
  exchange(a, b, badges);
  await flush();
  for (const peer of [a, b]) {
    expect(shown(peer)).toBe(stored(peer));
    const text = peer.editor.read(() => $table().getTextContent());
    for (let row = 0; row < 4; row++) {
      expect(text).toContain(`AA${row}`);
      expect(text).toContain(`BB${row}`);
    }
  }
  expect(shown(a)).toBe(shown(b));
  for (const peer of [a, b]) {
    peer.editor.dispose();
    peer.root.remove();
  }
});
