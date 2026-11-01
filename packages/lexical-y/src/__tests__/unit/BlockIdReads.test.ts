/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Blocks a remote change brings without a unique stored id (written by a
// client without BlockIdExtension, or a list whose items all store its id
// split by a concurrent edit) are named by the reader, from the document:
// a block that stores no id, or repeats one an earlier block stores, shows
// the id derived from its own Yjs identity. Applying a remote change writes
// nothing, and every reader (a fresh one too) shows the same ids.
// @vitest-environment node

import {
  $getBlockId,
  BlockIdExtension,
  blockIdState,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$createListItemNode, $createListNode} from '@lexical/list';
import {$createTableNodeWithDimensions} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $parseSerializedNode,
  $setState,
  configExtension,
  defineExtension,
  type ElementNode,
  type LexicalNode,
  type SerializedElementNode,
  type SerializedLexicalNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {expect, test} from 'vitest';

import {createYDoc, YCollabExtension} from '../..';
import {NODES} from '../utils/harness';

const idle = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

function peer(id: number, update: Uint8Array | null, blockIds: boolean) {
  const doc = createYDoc();
  doc.clientID = id;
  if (update !== null) {
    Y.applyUpdate(doc, update);
  }
  let next = 0;
  const warnings: string[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        ...(blockIds
          ? [
              configExtension(BlockIdExtension, {
                generateId: () => `b${id}_${next++}`,
              }),
            ]
          : []),
        configExtension(YCollabExtension, {
          doc,
          schemaVersion: 1,
          selfCheck: true,
        }),
      ],
      name: `peer${id}`,
      nodes: NODES,
      onError: e => {
        throw e;
      },
      onWarn: e => warnings.push(String(e)),
    }),
  );
  const binding = getExtensionDependencyFromEditor(editor, YCollabExtension)
    .output.binding;
  return {binding, doc, editor, warnings};
}
type Peer = ReturnType<typeof peer>;

function tree(p: Peer): string {
  return p.editor.getEditorState().read(() => {
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

/** How many structs the client that owns `doc` wrote into it. */
const written = (doc: Y.Doc) =>
  (doc.store.clients.get(doc.clientID) ?? []).length;

const $item = (text: string) =>
  $createListItemNode().append($createTextNode(text));

test('a document written without block ids: a reader with BlockIdExtension names its blocks from the document and writes nothing', async () => {
  const a = peer(1, null, false);
  a.editor.update(
    () => {
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append($createTextNode('one')),
          $createListNode('bullet').append($item('two'), $item('three')),
          $createParagraphNode().append($createTextNode('four')),
        );
    },
    {discrete: true},
  );
  a.binding.initialize();
  await idle();
  const stored = Y.encodeStateAsUpdate(a.doc);
  const b = peer(2, stored, true);
  const c = peer(3, stored, true);
  await idle();
  // Every block has an id, derived from the document, the same on both.
  expect(tree(b)).toBe(tree(c));
  expect(tree(b)).not.toMatch(/^\s*(paragraph|list|listitem)$/m);
  expect(tree(b)).toMatch(/list#y[0-9a-z]+_[0-9a-z]+_g/);
  expect(written(b.doc)).toBe(0);
  expect(written(c.doc)).toBe(0);
  // A remote edit read by B writes nothing either.
  a.editor.update(
    () => {
      $getRoot().getLastChildOrThrow().selectEnd();
      $getRoot().append($createParagraphNode().append($createTextNode('five')));
    },
    {discrete: true},
  );
  await idle();
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
  await idle();
  expect(written(b.doc)).toBe(0);
  expect(b.warnings).toEqual([]);
  // B's own edit of a block stores the id it shows.
  const before = tree(b);
  b.editor.update(
    () => {
      $getRoot().getFirstChildOrThrow().selectEnd();
      const p = $getRoot().getFirstChildOrThrow();
      if ($isElementNode(p)) {
        p.append($createTextNode('!'));
      }
    },
    {discrete: true},
  );
  await idle();
  const fresh = peer(4, Y.encodeStateAsUpdate(b.doc), true);
  await idle();
  expect(tree(fresh)).toBe(tree(b));
  expect(tree(b).split('\n')[1]).toBe(before.split('\n')[1]);
});

test('two lists that store the same id (a list split by a concurrent edit): the first keeps it, the second shows its derived id, nothing is written', async () => {
  const a = peer(1, null, true);
  a.editor.update(
    () => {
      $getRoot()
        .clear()
        .append(
          $createListNode('bullet').append($item('one'), $item('two')),
          $createParagraphNode().append($createTextNode('end')),
        );
    },
    {discrete: true},
  );
  a.binding.initialize();
  await idle();
  // B writes a copy of the list's last item marker after a paragraph: two
  // groups whose items store the list's id.
  const raw = new Y.Doc();
  raw.clientID = 5;
  Y.applyUpdate(raw, Y.encodeStateAsUpdate(a.doc));
  const root = raw.get('lexical-y');
  const markers: Y.Node[] = [];
  for (let it = root._start; it !== null; it = it.right) {
    const c = it.content as unknown as {type?: Y.Node};
    if (!it.deleted && c.type !== undefined) {
      markers.push(c.type);
    }
  }
  const listItem = markers[1];
  raw.transact(() => {
    const at = root.length - 4; // before "end" and its marker
    root.insert(at, 'mid');
    const para = new Y.Node('\u00b6');
    root.insert(at + 3, [para]);
    para.setAttr('s:blockId', 'raw_p');
    root.insert(at + 4, 'three');
    const copy = new Y.Node('\u00b6');
    root.insert(at + 9, [copy]);
    for (const [k, v] of Object.entries(listItem.getAttrs())) {
      copy.setAttr(k, k === 's:blockId' ? 'raw_i' : v);
    }
  });
  const stored = Y.encodeStateAsUpdate(raw);
  const b = peer(2, stored, true);
  const c = peer(3, stored, true);
  await idle();
  const shown = tree(b);
  expect(shown).toBe(tree(c));
  const lists = shown.split('\n').filter(l => /^ {2}list#/.test(l));
  expect(lists).toHaveLength(2);
  const listId = a.editor.read(() =>
    $getBlockId($getRoot().getFirstChildOrThrow()),
  );
  expect(lists[0]).toBe(`  list#${listId}`);
  expect(lists[1]).toMatch(/^ {2}list#y[0-9a-z]+_[0-9a-z]+_g$/);
  expect(written(b.doc)).toBe(0);
  expect(written(c.doc)).toBe(0);
  // Read as a remote change by A: written nothing, the same ids.
  const own = written(a.doc);
  Y.applyUpdate(a.doc, stored);
  await idle();
  expect(written(a.doc)).toBe(own);
  expect(tree(a)).toBe(shown);
  expect([...a.warnings, ...b.warnings]).toEqual([]);
});

test('blocks in two table cells that store one id: every reader settles it the same way, and the self-check does not warn', async () => {
  const a = peer(1, null, true);
  a.editor.update(
    () => {
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append($createTextNode('top')),
          $createTableNodeWithDimensions(1, 2, false),
        );
    },
    {discrete: true},
  );
  a.binding.initialize();
  await idle();
  // A copy written by another binding: the second cell's paragraph stores
  // the first cell's paragraph's id.
  type It = {
    content: {type?: Y.Node};
    deleted: boolean;
    right: It | null;
  };
  const markers: Y.Node[] = [];
  const walk = (y: Y.Node, depth: number) => {
    for (
      let it = (y as unknown as {_start: It | null})._start;
      it;
      it = it.right
    ) {
      if (!it.deleted && it.content.type) {
        const t = it.content.type;
        const attrs = t.getAttrs() as Record<string, unknown>;
        if (depth > 0 && typeof attrs['s:blockId'] === 'string') {
          markers.push(t);
        }
        walk(t, depth + 1);
      }
    }
  };
  walk(a.doc.get('lexical-y') as unknown as Y.Node, 0);
  expect(markers.length).toBeGreaterThanOrEqual(2);
  const id = markers[0].getAttr('s:blockId');
  a.doc.transact(() => markers[1].setAttr('s:blockId', id));
  await idle();
  const stored = Y.encodeStateAsUpdate(a.doc);
  const b = peer(2, stored, true);
  const c = peer(3, stored, true);
  await idle();
  // A remote change in the second cell, which B reads (and self-checks)
  // on its own.
  const sv = Y.encodeStateVector(b.doc);
  a.editor.update(
    () => {
      const cells = $assertNodeType(
        $assertNodeType(
          $getRoot().getLastChildOrThrow(),
          $isElementNode,
        ).getFirstChildOrThrow(),
        $isElementNode,
      );
      const p = $assertNodeType(
        $assertNodeType(
          cells.getLastChildOrThrow(),
          $isElementNode,
        ).getFirstChildOrThrow(),
        $isElementNode,
      );
      p.append($createTextNode('typed'));
    },
    {discrete: true},
  );
  await idle();
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, sv));
  Y.applyUpdate(c.doc, Y.encodeStateAsUpdate(a.doc, sv));
  await idle();
  expect(tree(b)).toBe(tree(c));
  const fresh = peer(4, Y.encodeStateAsUpdate(b.doc), true);
  await idle();
  expect(tree(fresh)).toBe(tree(b));
  expect(b.warnings.filter(w => w.includes('self-check'))).toEqual([]);
  expect(written(b.doc)).toBe(0);
});

// A list that is not an identified block (in a table cell, or nested in
// one) and stores an id, as a client without BlockIdExtension writes it: a
// client with BlockIdExtension shows no id there, whether it reads the
// change or loads the document (R10-A D1: a fresh reader showed the stored
// id, because the first lists it made from the document kept the id their
// JSON had), so a pasted copy repeats no id there. The writer, like a fresh
// reader without BlockIdExtension, shows the stored ids.
for (const how of ['set', 'set nested', 'paste', 'move'] as const) {
  test(`a list in a table cell that stores an id (${how}, by a client without BlockIdExtension): every client shows what a fresh reader with its configuration shows`, async () => {
    const a = peer(1, null, true);
    a.editor.update(
      () => {
        const table = $createTableNodeWithDimensions(1, 1, false);
        $assertNodeType(
          $assertNodeType(
            table.getFirstChildOrThrow(),
            $isElementNode,
          ).getFirstChildOrThrow(),
          $isElementNode,
        )
          .clear()
          .append(
            $createListNode('bullet').append(
              $item('in cell'),
              $createListItemNode().append(
                $createListNode('number').append($item('nested in cell')),
              ),
            ),
          );
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append($createTextNode('first')),
            table,
            $createListNode('number').append($item('top')),
          );
      },
      {discrete: true},
    );
    a.binding.initialize();
    await idle();
    const n = peer(2, Y.encodeStateAsUpdate(a.doc), false);
    const r = peer(3, Y.encodeStateAsUpdate(a.doc), true);
    await idle();
    const sv = Y.encodeStateVector(r.doc);
    n.editor.update(
      () => {
        const table = $getRoot().getChildAtIndex(1) as ElementNode;
        const cell = $assertNodeType(
          $assertNodeType(
            table.getFirstChildOrThrow(),
            $isElementNode,
          ).getFirstChildOrThrow(),
          $isElementNode,
        );
        const cellList = $assertNodeType(
          cell.getFirstChildOrThrow(),
          $isElementNode,
        );
        const top = $assertNodeType(
          $getRoot().getLastChildOrThrow(),
          $isElementNode,
        );
        if (how === 'set') {
          $setState(cellList, blockIdState, 'Q');
        } else if (how === 'set nested') {
          $setState(
            $assertNodeType(
              cellList.getLastChildOrThrow(),
              $isElementNode,
            ).getFirstChildOrThrow(),
            blockIdState,
            'Q',
          );
        } else if (how === 'paste') {
          const deep = (x: LexicalNode): SerializedLexicalNode => {
            const json = x.exportJSON() as SerializedElementNode;
            if ($isElementNode(x)) {
              json.children = x.getChildren().map(deep);
            }
            return json;
          };
          cell.append($parseSerializedNode(deep(top)));
        } else {
          cell.append(top);
        }
      },
      {discrete: true},
    );
    await idle();
    Y.applyUpdate(r.doc, Y.encodeStateAsUpdate(n.doc, sv));
    await idle();
    const fresh = peer(4, Y.encodeStateAsUpdate(n.doc), true);
    const freshWithout = peer(5, Y.encodeStateAsUpdate(n.doc), false);
    await idle();
    expect(tree(r)).toBe(tree(fresh));
    expect(tree(n)).toBe(tree(freshWithout));
    expect(tree(n)).not.toBe(tree(r));
    const ids = (tree(r).match(/#\S+/g) ?? []).sort();
    expect(new Set(ids).size).toBe(ids.length);
    expect(written(r.doc)).toBe(0);
    expect(written(fresh.doc)).toBe(0);
    for (const p of [r, fresh]) {
      expect(p.warnings.filter(w => w.includes('self-check'))).toEqual([]);
    }
  });
}
