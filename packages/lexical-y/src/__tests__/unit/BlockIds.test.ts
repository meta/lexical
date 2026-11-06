/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// @lexical/y with BlockIdExtension (which gives every new block an id): the
// update that names the blocks a remote change brings only sets ids, the
// author's normalization names what it creates as the author's edit, and the
// ids agree everywhere.

import {
  $getBlockId,
  BlockIdExtension,
  buildEditorFromExtensions,
  configExtension,
  defineExtension,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$createLinkNode} from '@lexical/link';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableNodeWithDimensions,
  $createTableRowNode,
  $deleteTableRowAtSelection,
  $insertTableColumnAtSelection,
  $insertTableRowAtSelection,
  $isTableNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isRootNode,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, type YBinding, YCollabExtension} from '../..';
import {$p, describeNode, NODES} from '../utils/harness';

type P = {
  name: string;
  doc: Y.Doc;
  editor: LexicalEditor;
  binding: YBinding;
  warnings: string[];
  updates: number;
};

function peer(name: string, clientID: number): P {
  const doc = createYDoc(null, {gc: false});
  doc.clientID = clientID;
  let n = 0;
  const p = {doc, name, updates: 0, warnings: []} as unknown as P;
  p.editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        configExtension(YCollabExtension, {
          doc,
          schemaVersion: 1,
          selfCheck: true,
        }),
        // Ids each client makes differently, as random ids are.
        configExtension(BlockIdExtension, {generateId: () => `${name}${++n}`}),
      ],
      name: 'block-ids-' + name,
      nodes: NODES,
      onError: (e: Error) => {
        throw e;
      },
      onWarn: (e: Error) => {
        p.warnings.push(e.message);
      },
    }),
  );
  p.binding = getExtensionDependencyFromEditor(
    p.editor,
    YCollabExtension,
  ).output.binding;
  p.editor.registerUpdateListener(() => {
    if (++p.updates > 2000) {
      throw new Error('runaway');
    }
  });
  return p;
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const send = (a: P, b: P) =>
  Y.applyUpdate(
    b.doc,
    Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)),
    'net',
  );

async function exchange(peers: P[]): Promise<void> {
  for (let round = 0; round < 4; round++) {
    for (const a of peers) {
      for (const b of peers) {
        if (a !== b) {
          send(a, b);
          await tick();
        }
      }
    }
  }
}

const describeP = (p: P) =>
  p.editor
    .getEditorState()
    .read(() => $getRoot().getChildren().map(describeNode).join(' / '));

const json = (p: P) => JSON.stringify(p.editor.getEditorState().toJSON());

/** Every node with an id: `[type, id]` in document order. */
function ids(p: P): [string, string][] {
  return p.editor.getEditorState().read(() => {
    const out: [string, string][] = [];
    const isIdentified = getExtensionDependencyFromEditor(
      p.editor,
      BlockIdExtension,
    ).output.$isIdentifiedBlock;
    const visit = (n: LexicalNode) => {
      const id = $getBlockId(n);
      if (!$isRootNode(n) && isIdentified(n)) {
        expect([n.getType(), id === null ? 'no id' : 'id']).toEqual([
          n.getType(),
          'id',
        ]);
      }
      if (id !== null && isIdentified(n)) {
        out.push([n.getType(), id]);
      }
      if ($isElementNode(n)) {
        n.getChildren().forEach(visit);
      }
    };
    visit($getRoot());
    return out;
  });
}

async function fresh(from: P): Promise<P> {
  const f = peer('F', 99);
  Y.applyUpdate(f.doc, Y.encodeStateAsUpdate(from.doc), 'net');
  f.binding.initialize();
  await tick();
  return f;
}

/**
 * Every client and a fresh reader show the same document, ids included;
 * identified blocks all have an id, and no two share one.
 */
async function expectConverged(peers: P[]): Promise<string> {
  const f = await fresh(peers[0]);
  const d = describeP(peers[0]);
  for (const p of [...peers, f]) {
    expect([p.name, describeP(p)]).toEqual([p.name, d]);
    expect([p.name, json(p)]).toEqual([p.name, json(peers[0])]);
    expect([p.name, p.warnings]).toEqual([p.name, []]);
  }
  const all = ids(peers[0]).map(([, id]) => id);
  expect(new Set(all).size).toBe(all.length);
  return d;
}

async function start(peers: P[], $init: () => void): Promise<void> {
  const [a] = peers;
  a.editor.update(
    () => {
      $getRoot().clear();
      $init();
    },
    {discrete: true},
  );
  a.binding.initialize();
  await tick();
  for (const p of peers.slice(1)) {
    send(a, p);
    p.binding.initialize();
    await tick();
  }
}

function $cellLine(r: number, c: number): ElementNode {
  const table = $getRoot().getChildren().find($isTableNode) as ElementNode;
  const row = table.getChildAtIndex(r) as ElementNode;
  return (row.getChildAtIndex(c) as ElementNode).getFirstChild() as ElementNode;
}

const shapeOf = (p: P) =>
  p.editor.getEditorState().read(() => {
    const table = $getRoot().getChildren().find($isTableNode) as ElementNode;
    return table
      .getChildren()
      .map(row => (row as ElementNode).getChildrenSize());
  });

describe('@lexical/y with BlockIdExtension', () => {
  test('YCollabExtension has the update that names blocks only set ids', () => {
    const p = peer('A', 1);
    expect(
      getExtensionDependencyFromEditor(p.editor, BlockIdExtension).config
        .repairTransforms,
    ).toBe(false);
  });

  test("the update that names the blocks a remote change brings stays out of the client's undo history", async () => {
    const A = peer('A', 1);
    // B has no BlockIdExtension: the blocks it writes have no id.
    const doc = createYDoc(null, {gc: false});
    doc.clientID = 2;
    const B = {
      binding: null as unknown as YBinding,
      doc,
      editor: buildEditorFromExtensions(
        defineExtension({
          dependencies: [
            configExtension(YCollabExtension, {doc, schemaVersion: 1}),
          ],
          name: 'block-ids-without',
          nodes: NODES,
          onError: (e: Error) => {
            throw e;
          },
        }),
      ),
      name: 'B',
      updates: 0,
      warnings: [],
    } as P;
    B.binding = getExtensionDependencyFromEditor(
      B.editor,
      YCollabExtension,
    ).output.binding;
    await start([A, B], () => $getRoot().append($p('base')));
    await exchange([A, B]);
    A.binding.undoManager!.clear();
    A.editor.update(
      () =>
        ($getRoot().getFirstChild() as ElementNode).selectEnd().insertText('!'),
      {discrete: true},
    );
    await tick();
    A.binding.undoManager!.stopCapturing();
    B.editor.update(() => $getRoot().append($p('fromB')), {discrete: true});
    send(B, A);
    await tick();
    const named = ids(A);
    expect(named.map(([type]) => type)).toEqual(['paragraph', 'paragraph']);
    // Only A's own edit is in its history: undo takes back the "!", and the
    // id A gave B's paragraph stays.
    expect(A.binding.undoManager!.undoStack.length).toBe(1);
    expect(A.binding.undo()).toBe(true);
    await tick();
    expect(describeP(A)).toBe('paragraph("base") / paragraph("fromB")');
    expect(ids(A)).toEqual(named);
    expect(A.binding.undo()).toBe(false);
    await exchange([A, B]);
    expect(describeP(B)).toBe(describeP(A));
    // A wrote no id for B's paragraph (reading a remote change writes
    // nothing): A derives it from the document, B, without BlockIdExtension,
    // shows none. Everything else is the same.
    const withoutIds = (s: string) =>
      JSON.stringify(JSON.parse(s), (k, v) => (k === '$' ? undefined : v));
    expect(withoutIds(json(B))).toBe(withoutIds(json(A)));
  });

  test('a column insert ‖ a row insert, then a row delete, 4 clients: the table ends rectangular', async () => {
    const peers = [peer('A', 9), peer('B', 8), peer('C', 7), peer('D', 4)];
    const [A, B, C, D] = peers;
    await start(peers, () =>
      $getRoot().append(
        $createParagraphNode(),
        $createTableNodeWithDimensions(2, 2, false),
        $createParagraphNode(),
      ),
    );
    const outbox = new Map<P, Uint8Array[]>(peers.map(p => [p, []]));
    for (const p of peers) {
      p.doc.on('update', (u: Uint8Array, origin: unknown) => {
        if (origin !== 'net') {
          outbox.get(p)!.push(u);
        }
      });
    }
    const deliver = async (from: P, to: P, a: number, b: number) => {
      for (const u of outbox.get(from)!.slice(a, b)) {
        Y.applyUpdate(to.doc, u, 'net');
        await tick();
      }
    };
    D.editor.update(
      () => {
        $cellLine(0, 0).selectStart();
        $insertTableColumnAtSelection(false);
      },
      {discrete: true},
    );
    C.editor.update(
      () => {
        $cellLine(0, 0).selectEnd();
        $insertTableRowAtSelection(true);
      },
      {discrete: true},
    );
    await tick();
    // Partial delivery: each client reads what it has.
    await deliver(D, B, 0, 1);
    await deliver(C, D, 0, 1);
    D.editor.update(
      () => {
        $cellLine(2, 1).selectEnd();
        $deleteTableRowAtSelection();
      },
      {discrete: true},
    );
    await tick();
    Y.applyUpdate(
      A.doc,
      Y.mergeUpdates(outbox.get(C)!.slice(0, 1) as Uint8Array<ArrayBuffer>[]),
      'net',
    );
    await tick();
    await deliver(D, A, 0, 4);
    await deliver(A, B, 1, 3);
    await deliver(C, B, 0, 1);
    await deliver(A, C, 1, 3);
    await deliver(D, C, 0, 4);
    await deliver(C, A, 1, 6);
    await exchange(peers);
    await expectConverged(peers);
    expect(shapeOf(A)).toEqual([3, 3]);
  });

  for (const ids2 of [
    [1, 2],
    [2, 1],
  ]) {
    test(`a row insert ‖ a column insert, then a row delete (ids ${ids2}): shown as stored until the next table command pads it`, async () => {
      const peers = [peer('A', ids2[0]), peer('B', ids2[1])];
      const [A, B] = peers;
      await start(peers, () =>
        $getRoot().append(
          $createTableNodeWithDimensions(2, 2, false),
          $createParagraphNode(),
        ),
      );
      A.editor.update(
        () => {
          $cellLine(0, 0).selectEnd();
          $insertTableRowAtSelection(true);
        },
        {discrete: true},
      );
      B.editor.update(
        () => {
          $cellLine(0, 1).selectEnd();
          $insertTableColumnAtSelection(true);
        },
        {discrete: true},
      );
      B.editor.update(
        () => {
          $cellLine(1, 0).selectEnd();
          $deleteTableRowAtSelection();
        },
        {discrete: true},
      );
      await tick();
      await exchange(peers);
      await expectConverged(peers);
      // Shown as stored: the column insert did not reach the inserted row.
      expect(shapeOf(A)).toEqual([3, 2]);
      // The next table command pads it, as the inserting client's edit.
      A.editor.update(
        () => {
          $cellLine(0, 0).selectEnd();
          $insertTableRowAtSelection(true);
        },
        {discrete: true},
      );
      await tick();
      await exchange(peers);
      await expectConverged(peers);
      expect(shapeOf(A)).toEqual([3, 3, 3]);
    });
  }

  for (const order of [
    [1, 2],
    [2, 1],
  ]) {
    test(`a row insert ‖ a column insert, then the column inserter undoes (ids ${order}): the column goes from the rows it reached`, async () => {
      const peers = [peer('A', order[0]), peer('B', order[1])];
      const [A, B] = peers;
      await start(peers, () =>
        $getRoot().append(
          $createTableNodeWithDimensions(2, 2, false),
          $createParagraphNode(),
        ),
      );
      A.editor.update(
        () => {
          $cellLine(0, 0).selectEnd();
          $insertTableRowAtSelection(true);
        },
        {discrete: true},
      );
      B.binding.undoManager!.stopCapturing();
      B.editor.update(
        () => {
          $cellLine(0, 1).selectEnd();
          $insertTableColumnAtSelection(true);
        },
        {discrete: true},
      );
      await tick();
      await exchange(peers);
      await expectConverged(peers);
      // The inserted row does not have the new column (shown as stored).
      expect(shapeOf(A)).toEqual([3, 2, 3]);
      B.binding.undoManager!.stopCapturing();
      B.binding.undo();
      await tick();
      await exchange(peers);
      await expectConverged(peers);
      expect(shapeOf(A)).toEqual([2, 2, 2]);
    });
  }

  for (const extra of [false, true]) {
    test(`a table written inside a paragraph without the normalization is lifted once, by its author${extra ? ' (more blocks after it)' : ''}`, async () => {
      const peers = [peer('A', 9), peer('B', 2), peer('C', 5), peer('D', 3)];
      const [A, B, C, D] = peers;
      await start(peers, () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('one')),
        );
        if (extra) {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('two')),
          );
        }
      });
      const out: Uint8Array[] = [];
      A.doc.on('update', (u: Uint8Array, origin: unknown) => {
        if (origin !== 'net') {
          out.push(u);
        }
      });
      A.editor.update(
        () => {
          ($getRoot().getFirstChild() as ElementNode).append(
            $createTableNode().append(
              $createTableRowNode().append(
                $createTableCellNode().append(
                  $createParagraphNode().append($createTextNode('cell')),
                ),
              ),
            ),
            $createTextNode('tail'),
          );
        },
        {discrete: true, skipTransforms: true},
      );
      await tick();
      // B and C get only the raw write (shown as written until the author's
      // normalization arrives); D gets everything at once.
      for (const p of [B, C]) {
        Y.applyUpdate(p.doc, out[0], 'net');
        await tick();
      }
      send(A, D);
      await tick();
      await exchange(peers);
      const d = await expectConverged(peers);
      expect(d).toBe(
        'paragraph("one") / table(tablerow(tablecell(paragraph("cell")))) / paragraph("tail")' +
          (extra ? ' / paragraph("two")' : ''),
      );
    });
  }

  test("ids of blocks the author's normalization creates are the author's, on every client", async () => {
    const peers = [peer('A', 1), peer('B', 2), peer('C', 3)];
    const [A] = peers;
    await start(peers, () =>
      $getRoot().append($createParagraphNode().append($createTextNode('x'))),
    );
    A.editor.update(
      () => {
        ($getRoot().getFirstChild() as ElementNode).append(
          $createTableNode().append(
            $createTableRowNode().append(
              $createTableCellNode().append($createTextNode('cell')),
            ),
          ),
          $createTextNode('y'),
        );
      },
      {discrete: true, skipTransforms: true},
    );
    await tick();
    await exchange(peers);
    await expectConverged(peers);
    // The author lifted the table out of the paragraph in its own edit,
    // which named the blocks it created with its own ids.
    expect(
      ids(A)
        .slice(1)
        .map(([type, id]) => `${type}:${id[0]}`),
    ).toEqual(['table:A', 'paragraph:A', 'paragraph:A']);
  });

  test('a link written directly in the root is wrapped once, with one id', async () => {
    const peers = [peer('A', 1), peer('B', 2), peer('C', 3)];
    const [A] = peers;
    await start(peers, () =>
      $getRoot().append($createParagraphNode().append($createTextNode('x'))),
    );
    A.editor.update(
      () => {
        $getRoot().append(
          $createLinkNode('https://lexical.dev').append(
            $createTextNode('loose'),
          ),
        );
      },
      {discrete: true, skipTransforms: true},
    );
    await tick();
    await exchange(peers);
    const d = await expectConverged(peers);
    expect(d).toBe(
      'paragraph("x") / paragraph(link<https://lexical.dev>("loose"))',
    );
    expect(ids(A).map(([type]) => type)).toEqual(['paragraph', 'paragraph']);
  });

  for (const ids2 of [
    [1, 2],
    [2, 1],
  ]) {
    test(`two clients that initialize a new document with the same content write one seed, ids included (ids ${ids2})`, async () => {
      // Each client's own generateId differs; the first content of a
      // document is named from the document (positional ids), alike.
      const peers = [peer('A', ids2[0]), peer('B', ids2[1])];
      for (const p of peers) {
        p.editor.update(
          () =>
            $getRoot()
              .clear()
              .append(
                $createParagraphNode().append($createTextNode('Hello')),
                $createParagraphNode(),
              ),
          {discrete: true},
        );
        p.binding.initialize();
      }
      await tick();
      const writers = (p: P) => [...p.doc.store.clients.keys()];
      // The same items under the same derived id, nothing under their own.
      expect(writers(peers[1])).toEqual(writers(peers[0]));
      expect(writers(peers[0])).not.toContain(peers[0].doc.clientID);
      await exchange(peers);
      expect(await expectConverged(peers)).toBe(
        'paragraph("Hello") / paragraph()',
      );
      expect(ids(peers[0]).length).toBe(2);
    });
  }

  for (const where of ['root', 'cell'] as const) {
    test(`a block removed while a peer types in it: the typing stays in one block, with one id everywhere (${where})`, async () => {
      const peers = [peer('A', 1), peer('B', 2), peer('C', 3)];
      const [A, B, C] = peers;
      await start(peers, () =>
        where === 'root'
          ? $getRoot().append(
              $createParagraphNode().append($createTextNode('one')),
              $createParagraphNode().append($createTextNode('two')),
            )
          : $getRoot().append(
              $createTableNode().append(
                $createTableRowNode().append(
                  $createTableCellNode().append(
                    $createParagraphNode().append($createTextNode('cell')),
                  ),
                ),
              ),
              $createParagraphNode().append($createTextNode('after')),
            ),
      );
      const $target = (): ElementNode =>
        where === 'root'
          ? ($getRoot().getLastChild() as ElementNode)
          : $cellLine(0, 0);
      const sv = Y.encodeStateVector(A.doc);
      // An agent removes the block while a person types at its end.
      A.editor.update(() => $target().remove(), {discrete: true});
      B.editor.update(() => $target().selectEnd().insertText('X'), {
        discrete: true,
      });
      await tick();
      const ua = Y.encodeStateAsUpdate(A.doc, sv);
      const ub = Y.encodeStateAsUpdate(B.doc, sv);
      Y.applyUpdate(C.doc, Y.mergeUpdates([ua, ub]), 'net');
      Y.applyUpdate(A.doc, ub, 'net');
      Y.applyUpdate(B.doc, ua, 'net');
      await tick();
      await exchange(peers);
      const d = await expectConverged(peers);
      // No client wrote a marker for the text the removal left (one empty
      // paragraph per client did, when the update naming blocks gave it one).
      expect(d).toBe(
        where === 'root'
          ? 'paragraph("one") / paragraph("X")'
          : 'table(tablerow(tablecell(paragraph("X")))) / paragraph("after")',
      );
      const $xId = () =>
        $getBlockId(where === 'root' ? $target() : $cellLine(0, 0));
      // Its id is derived from the document, the same on every client.
      const id = A.editor.getEditorState().read($xId);
      expect(id).toMatch(/^y[0-9a-z]+_[0-9a-z]+$/);
      // The person's next keystroke gives the line a marker that stores it.
      B.editor.update(() => $target().selectEnd().insertText('Y'), {
        discrete: true,
      });
      await tick();
      await exchange(peers);
      await expectConverged(peers);
      for (const p of peers) {
        expect(p.editor.getEditorState().read($xId)).toBe(id);
      }
    });
  }
});
