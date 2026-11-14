/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A collaborator's change is read while the editor's DOM holds a change it
// has not processed yet (here, a decorator rendering into its element, as
// React renders decorators: just before the change arrives, or in every
// commit). Lexical reverts such changes before the read commits, in an
// update that joins the read's pending state. That update ran node
// transforms, which the read itself skips, over everything the read changed:
// the table transform padded the rows a concurrent column delete and row
// insert left ragged, in this editor only. Its document lacks the padding
// cells, so words typed into them never reached anyone.

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
import {expect, onTestFinished, test, vi} from 'vitest';

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

/**
 * When the editor's DOM holds a change it has not processed: rendered just
 * before each update arrives, or rendered in every commit (as a decorator
 * that renders synchronously on commit does), so that the next commit in the
 * same task finds it.
 */
type Render =
  | 'before-arrival'
  | 'every-commit'
  | 'text-before-arrival'
  | 'text-every-commit'
  | 'spellcheck-before-arrival';

/**
 * A spellcheck or autocorrect edit of the DOM text of the last paragraph, a
 * TextNode the editor renders: the revert applies it to the editor state,
 * so it runs transforms (D130).
 */
function spellcheck(peer: Peer) {
  const key = peer.editor.read(() =>
    ($getRoot().getLastChildOrThrow() as ElementNode)
      .getFirstChildOrThrow()
      .getKey(),
  );
  const text = peer.editor.getElementByKey(key)!.firstChild as Text;
  text.data += ' fixed';
}

/**
 * Render the badge again by changing the value of its text node, as React
 * re-renders a decorator's text (a characterData change in DOM the editor
 * does not manage).
 */
let textRenders = 0;
function renderBadgeText(peer: Peer, key: NodeKey) {
  const element = peer.editor.getElementByKey(key)!;
  (element.firstChild as Text).nodeValue = `text render ${++textRenders}`;
}

/** Deliver what each peer sent to the other. */
function exchange(
  a: Peer,
  b: Peer,
  badges: Map<Peer, NodeKey>,
  render: Render,
) {
  for (const [from, to] of [
    [a, b],
    [b, a],
  ]) {
    if (render === 'before-arrival') {
      renderBadge(to, badges.get(to)!);
    } else if (render === 'text-before-arrival') {
      renderBadgeText(to, badges.get(to)!);
    } else if (render === 'spellcheck-before-arrival') {
      spellcheck(to);
    }
    for (const update of from.outbox.splice(0)) {
      Y.applyUpdate(to.doc, update, 'network');
    }
  }
}

const RENDERS: readonly Render[] = [
  'before-arrival',
  'every-commit',
  'text-before-arrival',
  'text-every-commit',
];

/**
 * The known limit (D130): a DOM text edit in a TextNode of the editor
 * (spellcheck) reverted in the same flush as the read makes the revert run
 * every transform over what the read changed, so the table is padded in
 * that editor, as on main.
 */
const LIMITS: readonly Render[] = ['spellcheck-before-arrival'];

async function raggedTable(render: Render) {
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
          render === 'spellcheck-before-arrival'
            ? $createParagraphNode().append($createTextNode('tail'))
            : $createParagraphNode(),
        );
    },
    {discrete: true},
  );
  if (render === 'spellcheck-before-arrival') {
    // The revert applies DOM text only once the last text entry is more
    // than 100 ms ago (TEXT_MUTATION_VARIANCE), which starts at 0.
    const clock = vi
      .spyOn(performance, 'now')
      .mockReturnValue(performance.now() + 1000);
    onTestFinished(() => clock.mockRestore());
  }
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
  if (render.startsWith('text-')) {
    // Rendered once already (a childList change), processed.
    for (const peer of [a, b]) {
      renderBadge(peer, badges.get(peer)!);
    }
    await flush();
  }
  if (render === 'every-commit' || render === 'text-every-commit') {
    let renders = 0;
    for (const peer of [a, b]) {
      peer.editor.registerUpdateListener(() => {
        const element = peer.editor.getElementByKey(badges.get(peer)!);
        if (element === null) {
          return;
        }
        if (render === 'text-every-commit') {
          renderBadgeText(peer, badges.get(peer)!);
        } else {
          element.textContent = `render ${++renders}`;
        }
      });
    }
    // An edit of each, so that each has rendered once.
    for (const [peer, word] of [
      [a, 'note'],
      [b, 'memo'],
    ] as const) {
      peer.editor.update(
        () => {
          ($getRoot().getLastChildOrThrow() as ElementNode).append(
            $createTextNode(word),
          );
        },
        {discrete: true},
      );
    }
  }
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
  exchange(a, b, badges, render);
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
  exchange(a, b, badges, render);
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
}

test.each(RENDERS)(
  'a table a collaborator left ragged is shown as stored, and words typed into it reach every client (DOM change %s)',
  raggedTable,
);

test.fails.each(LIMITS)(
  'a table a collaborator left ragged is shown as stored, and words typed into it reach every client (DOM change %s): known limit D130',
  raggedTable,
);
