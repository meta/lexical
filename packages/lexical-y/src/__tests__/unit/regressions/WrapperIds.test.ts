/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// ProdE3WrapperIds (prod-emily3, A6-2): with a `$isIdentifiedBlock` that does
// not identify a wrapper item (the list item holding a nested list), such as
// Meta Artifacts' root-only `$isRootChildBlock`, a wrapper item a peer
// inserted showed an id derived from its nested list (`y…_w`) on the other
// peers and on fresh readers, and none on its author: NodeState differed
// between clients with equal text and structure, and undo and redo changed
// or added the derived id. A reader now gives a wrapper item the id it
// derives only where it is an identified block, as the author's
// BlockIdExtension gives one only there; an id its nested items store is its
// author's and stays. Covered for several predicates (root only, the
// default, every block, and custom ones), both client id orders, a document
// written without ids, and undo and redo.

import {
  $defaultIsIdentifiedBlock,
  $isRootChildBlock,
  BlockIdExtension,
  blockIdState,
  buildEditorFromExtensions,
  configExtension,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $isDecoratorNode,
  $isElementNode,
  $isRootNode,
  defineExtension,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  ParagraphNode,
  TextNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

import {createYDoc, type YBinding, YCollabExtension} from '../../..';

const NET = 'net';

type Predicate = (node: LexicalNode) => boolean;

const PREDICATES: [string, Predicate][] = [
  ['root only ($isRootChildBlock)', $isRootChildBlock],
  ['the default', $defaultIsIdentifiedBlock],
  [
    'every block',
    n =>
      ($isElementNode(n) || $isDecoratorNode(n)) &&
      !$isRootNode(n) &&
      !n.isInline(),
  ],
  [
    'custom: root blocks and top-level list items',
    n =>
      $isRootChildBlock(n) ||
      ($isListItemNode(n) && $isRootChildBlock(n.getParentOrThrow())),
  ],
  [
    'custom: root blocks and every list',
    n => $isRootChildBlock(n) || $isListNode(n),
  ],
];

type Client = {
  doc: Y.Doc;
  editor: LexicalEditor;
  binding: YBinding;
  out: Uint8Array[];
  warnings: string[];
};

/**
 * A client with YCollabExtension and, unless `predicate` is null, with
 * BlockIdExtension configured with it; `state`: what it loads first.
 */
function client(
  id: number,
  predicate: Predicate | null,
  state: Uint8Array | null = null,
): Client {
  const doc = createYDoc();
  doc.clientID = id;
  if (state !== null) {
    Y.applyUpdate(doc, state, NET);
  }
  const out: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== NET) {
      out.push(u);
    }
  });
  const warnings: string[] = [];
  let next = 0;
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        configExtension(YCollabExtension, {
          doc,
          schemaVersion: 1,
          selfCheck: true,
        }),
        ...(predicate === null
          ? []
          : [
              configExtension(BlockIdExtension, {
                $isIdentifiedBlock: predicate,
                generateId: () => `b${id}x${next++}`,
              }),
            ]),
      ],
      name: 'wrapper-ids-' + id,
      namespace: 'wrapper-ids',
      nodes: [ParagraphNode, TextNode, ListNode, ListItemNode],
      onError: e => {
        throw e;
      },
      onWarn: e => {
        warnings.push(e.message);
      },
    }),
  );
  const {binding} = getExtensionDependencyFromEditor(
    editor,
    YCollabExtension,
  ).output;
  return {binding, doc, editor, out, warnings};
}

const flush = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise(r => setTimeout(r, 0));
  }
};

function deliver(from: Client, ...to: Client[]) {
  const updates = from.out.splice(0);
  for (const c of to) {
    for (const u of updates) {
      Y.applyUpdate(c.doc, u, NET);
    }
  }
}

async function reader(id: number, predicate: Predicate, from: Client) {
  const c = client(id, predicate, Y.encodeStateAsUpdate(from.doc));
  await flush();
  return c;
}

/** Every block's type and blockId, depth first. */
function ids(c: Client): string[] {
  return c.editor.getEditorState().read(() => {
    const out: string[] = [];
    const visit = (n: LexicalNode, depth: number) => {
      const id = $getState(n, blockIdState);
      out.push(`${'  '.repeat(depth)}${n.getType()} ${id ?? '-'}`);
      if ($isElementNode(n)) {
        n.getChildren().forEach(k => visit(k, depth + 1));
      }
    };
    $getRoot()
      .getChildren()
      .forEach(k => visit(k, 0));
    return out;
  });
}

/**
 * The blocks whose having an id disagrees with `predicate`: an identified
 * block without one, or a block that is not one with an id. Blocks whose
 * text holds `stored` keep an id stored for them (`stored` blocks only).
 */
function misidentified(c: Client, predicate: Predicate): string[] {
  return c.editor.getEditorState().read(() => {
    const out: string[] = [];
    const visit = (n: LexicalNode) => {
      if ($isElementNode(n) || $isDecoratorNode(n)) {
        const has = $getState(n, blockIdState) !== undefined;
        if (has !== predicate(n)) {
          out.push(
            `${n.getType()} "${n.getTextContent().slice(0, 20)}" ${
              has ? 'has an id' : 'has none'
            }`,
          );
        }
      }
      if ($isElementNode(n)) {
        n.getChildren().forEach(visit);
      }
    };
    $getRoot().getChildren().forEach(visit);
    return out;
  });
}

function $item(text: string): ListItemNode {
  return $createListItemNode().append($createTextNode(text));
}

function $wrapper(...texts: string[]): ListItemNode {
  return $createListItemNode().append(
    $createListNode('bullet').append(...texts.map($item)),
  );
}

async function expectAgree(
  clients: Client[],
  predicate: Predicate,
  label: string,
) {
  await flush();
  const [first, ...rest] = clients;
  for (const c of rest) {
    expect(ids(c), `${label}: client ${c.doc.clientID}`).toEqual(ids(first));
  }
  for (const c of clients) {
    expect(
      misidentified(c, predicate),
      `${label}: client ${c.doc.clientID}`,
    ).toEqual([]);
    expect(c.warnings, `${label}: client ${c.doc.clientID}`).toEqual([]);
  }
}

function undo(c: Client) {
  c.binding.undoManager!.stopCapturing();
  c.binding.undo();
}

function redo(c: Client) {
  c.binding.undoManager!.stopCapturing();
  c.binding.redo();
}

for (const [name, predicate] of PREDICATES) {
  for (const [ida, idb] of [
    [1, 2],
    [2, 1],
  ]) {
    describe(`${name}, client ids ${ida} and ${idb}`, () => {
      test('a peer inserts a wrapper item into a shared list: every peer and a fresh reader show the same ids, and only identified blocks have one', async () => {
        const a = client(ida, predicate);
        a.editor.update(
          () => {
            $getRoot()
              .clear()
              .append(
                $createListNode('bullet').append($item('one'), $item('two')),
              );
          },
          {discrete: true},
        );
        a.binding.initialize();
        await flush();
        const b = await reader(idb, predicate, a);
        b.editor.update(
          () => {
            const list = $assertNodeType(
              $getRoot().getFirstChildOrThrow(),
              $isElementNode,
            );
            list.getLastChildOrThrow().insertAfter($wrapper('nested'));
          },
          {discrete: true},
        );
        await flush();
        deliver(b, a);
        await flush();
        deliver(a, b);
        const fresh = await reader(9, predicate, a);
        await expectAgree([b, a, fresh], predicate, 'after the insert');
      });

      test("a nested list in the document before the others open it: every reader shows the author's ids", async () => {
        const a = client(ida, predicate);
        a.editor.update(
          () => {
            $getRoot()
              .clear()
              .append(
                $createParagraphNode().append($createTextNode('top')),
                $createListNode('bullet').append(
                  $item('one'),
                  $wrapper('nested', 'deeper'),
                  $item('three'),
                ),
              );
          },
          {discrete: true},
        );
        a.binding.initialize();
        await flush();
        const b = await reader(idb, predicate, a);
        const fresh = await reader(9, predicate, a);
        await expectAgree([a, b, fresh], predicate, 'on load');
      });

      test('undo and redo of an inserted wrapper item keep every client equal', async () => {
        const a = client(ida, predicate);
        a.editor.update(
          () => {
            $getRoot()
              .clear()
              .append(
                $createListNode('bullet').append($item('one'), $item('two')),
              );
          },
          {discrete: true},
        );
        a.binding.initialize();
        await flush();
        const b = await reader(idb, predicate, a);
        b.binding.undoManager!.clear();
        b.editor.update(
          () => {
            const list = $assertNodeType(
              $getRoot().getFirstChildOrThrow(),
              $isElementNode,
            );
            list.getFirstChildOrThrow().insertAfter($wrapper('nested'));
          },
          {discrete: true},
        );
        await flush();
        deliver(b, a);
        await expectAgree([b, a], predicate, 'after the insert');
        const before = ids(b);
        for (const [step, run] of [
          ['undo', undo],
          ['redo', redo],
          ['undo again', undo],
          ['redo again', redo],
        ] as const) {
          run(b);
          await flush();
          deliver(b, a);
          await flush();
          deliver(a, b);
          const fresh = await reader(9, predicate, b);
          await expectAgree([b, a, fresh], predicate, step);
        }
        // A redo brings back the ids the insert showed.
        expect(ids(b)).toEqual(before);
      });

      test("undo and redo of an item added before a nested list's first item keep every client equal", async () => {
        const a = client(ida, predicate);
        a.editor.update(
          () => {
            $getRoot()
              .clear()
              .append(
                $createListNode('bullet').append(
                  $item('one'),
                  $wrapper('nested'),
                  $item('three'),
                ),
              );
          },
          {discrete: true},
        );
        a.binding.initialize();
        await flush();
        const b = await reader(idb, predicate, a);
        b.binding.undoManager!.clear();
        b.editor.update(
          () => {
            const list = $assertNodeType(
              $getRoot().getFirstChildOrThrow(),
              $isElementNode,
            );
            const wrapper = list.getChildAtIndex(1) as ElementNode;
            const nested = $assertNodeType(
              wrapper.getFirstChildOrThrow(),
              $isElementNode,
            );
            nested.getFirstChildOrThrow().insertBefore($item('first'));
          },
          {discrete: true},
        );
        await flush();
        deliver(b, a);
        await expectAgree([b, a], predicate, 'after the insert');
        for (const [step, run] of [
          ['undo', undo],
          ['redo', redo],
        ] as const) {
          run(b);
          await flush();
          deliver(b, a);
          await flush();
          deliver(a, b);
          const fresh = await reader(9, predicate, b);
          await expectAgree([b, a, fresh], predicate, step);
        }
      });

      test('a document written without block ids: readers derive ids for the identified blocks only, the same on every reader', async () => {
        const w = client(ida, null);
        w.editor.update(
          () => {
            $getRoot()
              .clear()
              .append(
                $createListNode('bullet').append(
                  $item('one'),
                  $wrapper('nested', 'deeper'),
                ),
              );
          },
          {discrete: true},
        );
        w.binding.initialize();
        await flush();
        const b = await reader(idb, predicate, w);
        const c = await reader(9, predicate, w);
        await expectAgree([b, c], predicate, 'on load');
        // A remote edit inside the nested list, read by both.
        w.editor.update(
          () => {
            const list = $assertNodeType(
              $getRoot().getFirstChildOrThrow(),
              $isElementNode,
            );
            const wrapper = list.getChildAtIndex(1) as ElementNode;
            $assertNodeType(wrapper.getFirstChildOrThrow(), $isElementNode)
              .getFirstChildOrThrow()
              .insertBefore($item('zero'));
          },
          {discrete: true},
        );
        await flush();
        deliver(w, b, c);
        await expectAgree([b, c], predicate, 'after a remote edit');
      });
    });
  }
}
