/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A follow-up (here the update Lexical makes when an extension registers
// its transforms after the document was read) whose change the binding does
// not write is read again: every container it touched shows what is stored
// again, with the stored NodeState, and nothing it moved is deleted from
// the document. Shapes a document can hold after concurrent edits: two
// lists in one item's line, a list in a heading's line.
// @vitest-environment node

import {
  $getBlockId,
  BlockIdExtension,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {MarkStateExtension} from '@lexical/mark';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  configExtension,
  createEditor,
  defineExtension,
  type LexicalNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YCollabExtension} from '../..';
import {NODES} from '../utils/harness';
import {writeEditorToYDoc} from '../utils/headless';

const idle = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

type Piece =
  | string
  | {name: string; attrs: Record<string, unknown>; content?: Piece[]};

function insertPieces(target: Y.Node, pieces: Piece[], from?: number): void {
  let at = from ?? target.length;
  for (const piece of pieces) {
    if (typeof piece === 'string') {
      target.insert(at, piece);
      at += piece.length;
    } else {
      const node = new Y.Node(piece.name);
      target.insert(at, [node]);
      at += 1;
      for (const k in piece.attrs) {
        node.setAttr(k, piece.attrs[k]);
      }
      if (piece.content !== undefined) {
        insertPieces(node, piece.content);
      }
    }
  }
}

const MARKER = '\u00b6';
const marker = (attrs: Record<string, unknown> = {}): Piece => ({
  attrs,
  name: MARKER,
});
let ids = 0;
const nextId = () => `stored_${ids++}`;
const item0 = (): Piece =>
  marker({
    g: 'list',
    'g:$': {blockId: 'list_0'},
    'g:listType': 'bullet',
    l: 0,
    's:blockId': nextId(),
    t: 'listitem',
  });
const nestedList = (...content: Piece[]): Piece => ({
  attrs: {c: 'b', 'p:listType': 'bullet'},
  content,
  name: 'i:list',
});
const inner = (): Piece => marker({'s:blockId': nextId(), t: 'listitem'});

/**
 * A document holding `pieces` before a paragraph `end`, in the stored form
 * concurrent edits can leave (a line holding nested list nodes).
 */
function storedDoc(pieces: Piece[]): Uint8Array {
  const editor = createEditor({
    nodes: NODES,
    onError: e => {
      throw e;
    },
  });
  editor.update(
    () => {
      $getRoot()
        .clear()
        .append($createParagraphNode().append($createTextNode('end')));
    },
    {discrete: true},
  );
  const doc = createYDoc();
  doc.clientID = 1;
  writeEditorToYDoc(editor, doc);
  // Before the paragraph.
  doc.transact(() => {
    const root = doc.get('lexical-y');
    insertPieces(root, pieces, 0);
    // The kinds a client that wrote these records (see recordPins).
    root.setAttr('k:listitem', 'line');
    root.setAttr('k:list', 'group|listType');
    root.setAttr('k:heading', 'line');
  });
  return Y.encodeStateAsUpdate(doc);
}

/**
 * A reader with BlockIdExtension: registered after the binding (its
 * transforms are registered once the document is read, a registration
 * pass) or before it.
 */
function reader(id: number, update: Uint8Array, blockIdsLate: boolean) {
  const doc = createYDoc();
  doc.clientID = id;
  Y.applyUpdate(doc, update);
  let next = 0;
  const blockIds = configExtension(BlockIdExtension, {
    generateId: () => `r${id}_${next++}`,
  });
  const collab = configExtension(YCollabExtension, {
    doc,
    schemaVersion: 1,
    selfCheck: true,
  });
  const warnings: string[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: blockIdsLate
        ? [collab, blockIds, MarkStateExtension]
        : [blockIds, MarkStateExtension, collab],
      name: `reader${id}`,
      nodes: NODES,
      onError: e => {
        throw e;
      },
      onWarn: e => warnings.push(String(e)),
    }),
  );
  getExtensionDependencyFromEditor(editor, YCollabExtension);
  return {doc, editor, warnings};
}

function tree(editor: ReturnType<typeof reader>['editor']): string {
  return editor.getEditorState().read(() => {
    const out: string[] = [];
    const walk = (n: LexicalNode, depth: number) => {
      const id = $getBlockId(n);
      out.push(
        '  '.repeat(depth) +
          n.getType() +
          (id === null ? '' : '#' + id) +
          ($isElementNode(n) ? '' : ' ' + JSON.stringify(n.getTextContent())),
      );
      if ($isElementNode(n)) {
        n.getChildren().forEach(c => walk(c, depth + 1));
      }
    };
    walk($getRoot(), 0);
    return out.join('\n');
  });
}

const liveText = (doc: Y.Doc) => JSON.stringify(doc.get('lexical-y').toJSON());

const SHAPES: [string, Piece[]][] = [
  [
    'two lists in one item line',
    [
      'top',
      item0(),
      'before',
      nestedList('one', inner(), 'two', inner()),
      nestedList('three', inner()),
      'after',
      item0(),
    ],
  ],
  [
    'a list in a heading line',
    [
      'first',
      nestedList('inner', inner()),
      marker({'p:tag': 'h2', 's:blockId': nextId(), t: 'heading'}),
    ],
  ],
];

for (const [name, pieces] of SHAPES) {
  test(`${name}: a registration pass after the read changes nothing`, async () => {
    const stored = storedDoc(pieces);
    const early = reader(2, stored, false);
    const late = reader(3, stored, true);
    await idle();
    const before = liveText(early.doc);
    // The ids every reader gives these blocks are the same; the client that
    // registered BlockIdExtension late shows what the other shows.
    expect(tree(late.editor)).toBe(tree(early.editor));
    // Nothing the refused change moved was deleted from the document.
    expect(liveText(late.doc)).toBe(before);
    expect(late.warnings).toEqual([]);
  });
}
