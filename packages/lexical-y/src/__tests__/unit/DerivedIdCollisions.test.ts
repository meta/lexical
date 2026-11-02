/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The ids a reader shows are unique without any write: derived ids are
// unique across nesting levels (wrapper items and lists nested at the start
// of a list), a block storing another block's derived id (a JSON copy of
// what a reader showed, also of a fallback `_d` id, or of the derived id a
// later holder of a repeated id shows) competes with the block deriving it,
// the first in document order keeping it.

import {
  $defaultIsIdentifiedBlock,
  $getBlockId,
  BlockIdExtension,
  blockIdState,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  type ListItemNode,
} from '@lexical/list';
import * as Y from '@y/y';
import {
  $create,
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
  type SerializedLexicalNode,
  type TextNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {expect, test} from 'vitest';

import {createYDoc, YCollabExtension} from '../..';
import {$createBoxNode, NODES, WidgetNode} from '../utils/harness';

const NET = Symbol('net');

const idle = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

function peer(
  id: number,
  blockIds: boolean,
  doc = createYDoc(null, {gc: false}),
  identified: (node: LexicalNode) => boolean = $defaultIsIdentifiedBlock,
  // Off where the test is that a client shows what a fresh reader shows
  // without it (the self-check reads a container again when it differs).
  selfCheck = true,
) {
  doc.clientID = id;
  let next = 0;
  const writes: number[] = [];
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== NET) {
      writes.push(update.length);
    }
  });
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        ...(blockIds
          ? [
              configExtension(BlockIdExtension, {
                $isIdentifiedBlock: identified,
                generateId: () => `b${id}x${next++}`,
              }),
            ]
          : []),
        configExtension(YCollabExtension, {doc, schemaVersion: 1, selfCheck}),
      ],
      name: `peer${id}`,
      nodes: NODES,
      onError: e => {
        throw e;
      },
    }),
  );
  const binding = getExtensionDependencyFromEditor(editor, YCollabExtension)
    .output.binding;
  return {binding, doc, editor, writes};
}
type P = ReturnType<typeof peer>;

/** A reader (with BlockIdExtension) of what `from` stores. */
async function reader(
  id: number,
  from: Y.Doc,
  identified?: (node: LexicalNode) => boolean,
  selfCheck = true,
): Promise<P> {
  const doc = createYDoc(null, {gc: from.gc});
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(from), NET);
  const p = peer(id, true, doc, identified, selfCheck);
  p.binding.initialize();
  await idle();
  return p;
}

function deliver(from: P, to: P) {
  Y.applyUpdate(
    to.doc,
    Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)),
    NET,
  );
}

/** Every block id the editor shows, in document order. */
function ids(p: P): string[] {
  return p.editor.getEditorState().read(() => {
    const out: string[] = [];
    const walk = (n: LexicalNode) => {
      const id = $getBlockId(n);
      if (id !== null) {
        out.push(id);
      }
      if ($isElementNode(n)) {
        n.getChildren().forEach(walk);
      }
    };
    walk($getRoot());
    return out;
  });
}

const unique = (xs: string[]) => new Set(xs).size === xs.length;

test('wrapper items nested at the start of a list, written without ids: unique derived ids, nothing written on load or on a remote change', async () => {
  const a = peer(1, false);
  a.editor.update(
    () => {
      const item = (t: string) =>
        $createListItemNode().append($createTextNode(t));
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append($createTextNode('top')),
          $createListNode('bullet').append(
            item('a'),
            // A wrapper item whose nested list starts with another one.
            $createListItemNode().append(
              $createListNode('bullet').append(
                $createListItemNode().append(
                  $createListNode('bullet').append(item('b'), item('c')),
                ),
                item('d'),
              ),
            ),
          ),
        );
    },
    {discrete: true},
  );
  a.binding.initialize();
  await idle();
  const b = await reader(2, a.doc);
  const c = await reader(3, a.doc);
  expect(unique(ids(b))).toBe(true);
  expect(b.writes).toEqual([]);
  a.editor.update(
    () => {
      ($getRoot().getFirstChild() as ElementNode).append($createTextNode('!'));
    },
    {discrete: true},
  );
  deliver(a, b);
  deliver(a, c);
  await idle();
  expect(b.writes).toEqual([]);
  expect(c.writes).toEqual([]);
  expect(ids(c)).toEqual(ids(b));
});

for (const gc of [false, true]) {
  test(`a line storing another line's derived id (gc ${gc}): unique ids on load, nothing written`, async () => {
    const doc = new Y.Doc({gc});
    doc.clientID = 7;
    const root = doc.get('lexical-y');
    const first = new Y.Node('¶');
    const second = new Y.Node('¶');
    doc.transact(() => {
      root.setAttr('lexical-y:1', true);
      root.setAttr('k:paragraph', 'line');
      root.insert(0, 'one');
      root.insert(3, [first]);
      root.insert(4, 'two');
      root.insert(7, [second]);
    });
    const item = first._item!;
    const derived = `y${item.id.client.toString(36)}_${item.id.clock.toString(36)}`;
    second.setAttr('s:blockId', derived);
    const p = await reader(100, doc);
    const shown = ids(p);
    // The first in document order keeps it.
    expect(shown[0]).toBe(derived);
    expect(unique(shown)).toBe(true);
    expect(p.writes).toEqual([]);
  });
}

test('a writer without BlockIdExtension pastes the JSON of a paragraph a reader showed with a derived id: the reader writes nothing', async () => {
  const a = peer(11, false);
  a.editor.update(
    () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('original')),
      );
    },
    {discrete: true},
  );
  a.binding.initialize();
  await idle();
  const b = await reader(12, a.doc);
  const copied = b.editor.getEditorState().toJSON().root.children[0];
  a.editor.update(
    () => {
      $getRoot().append($parseSerializedNode(copied));
    },
    {discrete: true},
  );
  await idle();
  deliver(a, b);
  await idle();
  const shown = ids(b);
  expect(shown.length).toBe(2);
  expect(unique(shown)).toBe(true);
  expect(b.writes).toEqual([]);
  const fresh = await reader(13, b.doc);
  expect(ids(fresh)).toEqual(shown);
  expect(fresh.writes).toEqual([]);
});

for (const gc of [false, true]) {
  test(`a copy of the derived id a later holder of a repeated id shows (gc ${gc}): unique ids, nothing written on a remote change or on load`, async () => {
    // A writer without BlockIdExtension stores one id on two paragraphs.
    const a = peer(21, false, createYDoc(null, {gc}));
    a.editor.update(
      () => {
        for (const text of ['first', 'second']) {
          const paragraph = $createParagraphNode().append(
            $createTextNode(text),
          );
          $setState(paragraph, blockIdState, 'dup');
          $getRoot().append(paragraph);
        }
      },
      {discrete: true},
    );
    a.binding.initialize();
    await idle();
    // The second shows its derived id on a reader; its JSON is pasted as
    // the reader shows it.
    const b = await reader(22, a.doc);
    expect(ids(b)[0]).toBe('dup');
    const copied = b.editor.getEditorState().toJSON().root.children[1];
    a.editor.update(
      () => {
        $getRoot().append($parseSerializedNode(copied));
      },
      {discrete: true},
    );
    await idle();
    deliver(a, b);
    await idle();
    const shown = ids(b);
    expect(shown.length).toBe(3);
    expect(unique(shown)).toBe(true);
    expect(b.writes).toEqual([]);
    const fresh = await reader(23, a.doc);
    expect(ids(fresh)).toEqual(shown);
    expect(fresh.writes).toEqual([]);
  });

  test(`a copy of the fallback id a paragraph shows after a copy of its derived id (gc ${gc}): unique ids, nothing written`, async () => {
    const a = peer(31, false, createYDoc(null, {gc}));
    a.editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('original')),
        );
      },
      {discrete: true},
    );
    a.binding.initialize();
    await idle();
    const b = await reader(32, a.doc);
    const c = await reader(33, a.doc);
    // A copy of the paragraph as a reader shows it, before it: the copy
    // keeps the derived id, the original shows it followed by `_d`.
    const copied = b.editor.getEditorState().toJSON().root.children[0];
    a.editor.update(
      () => {
        $getRoot()
          .getFirstChildOrThrow()
          .insertBefore($parseSerializedNode(copied));
      },
      {discrete: true},
    );
    deliver(a, b);
    deliver(a, c);
    await idle();
    const before = ids(b);
    expect(before[1]).toBe(before[0] + '_d');
    // A copy of the original as it shows now, with that fallback id.
    const fallback = b.editor.getEditorState().toJSON().root.children[1];
    a.editor.update(
      () => {
        $getRoot().append($parseSerializedNode(fallback));
      },
      {discrete: true},
    );
    deliver(a, b);
    deliver(a, c);
    await idle();
    const shown = ids(b);
    expect(shown.length).toBe(3);
    expect(unique(shown)).toBe(true);
    expect(ids(c)).toEqual(shown);
    expect(b.writes).toEqual([]);
    expect(c.writes).toEqual([]);
    const fresh = await reader(34, a.doc);
    expect(ids(fresh)).toEqual(shown);
    expect(fresh.writes).toEqual([]);
  });
}

test('lists identified at every level, a list starting with a nested list, written without ids: unique derived ids, nothing written on load or on a remote change', async () => {
  const $identified = (n: LexicalNode) =>
    $defaultIsIdentifiedBlock(n) || $isListNode(n);
  const a = peer(41, false);
  a.editor.update(
    () => {
      const item = (t: string) =>
        $createListItemNode().append($createTextNode(t));
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append($createTextNode('top')),
          $createListNode('bullet').append(
            item('a'),
            $createListItemNode().append(
              $createListNode('bullet').append(
                $createListItemNode().append(
                  $createListNode('bullet').append(item('b'), item('c')),
                ),
                item('d'),
              ),
            ),
          ),
          // A list that starts with a nested list.
          $createListNode('number').append(
            $createListItemNode().append(
              $createListNode('number').append(item('e')),
            ),
          ),
        );
    },
    {discrete: true},
  );
  a.binding.initialize();
  await idle();
  const b = await reader(42, a.doc, $identified);
  const c = await reader(43, a.doc, $identified);
  expect(unique(ids(b))).toBe(true);
  expect(b.writes).toEqual([]);
  a.editor.update(
    () => {
      ($getRoot().getFirstChild() as ElementNode).append($createTextNode('!'));
    },
    {discrete: true},
  );
  deliver(a, b);
  deliver(a, c);
  await idle();
  expect(b.writes).toEqual([]);
  expect(c.writes).toEqual([]);
  expect(ids(c)).toEqual(ids(b));
  expect(unique(ids(b))).toBe(true);
});

for (const gc of [false, true]) {
  test(`a line storing the derived id of a line that loses its marker later (gc ${gc}): unique ids, nothing written`, async () => {
    // A line whose marker a remote change removes derives its id from its
    // first character; another line already stores that id (a copy).
    const doc = new Y.Doc({gc});
    doc.clientID = 7;
    const root = doc.get('lexical-y');
    const first = new Y.Node('¶');
    const second = new Y.Node('¶');
    doc.transact(() => {
      root.setAttr('lexical-y:1', true);
      root.setAttr('k:paragraph', 'line');
      root.insert(0, 'one');
      root.insert(3, [first]);
      root.insert(4, 'two');
      root.insert(7, [second]);
    });
    // The item of "two" (its first character).
    let two: Y.Item | null = first._item!.right;
    while (two !== null && !(two.content instanceof Y.ContentString)) {
      two = two.right;
    }
    const implicit = `y${two!.id.client.toString(36)}_${two!.id.clock.toString(36)}`;
    first.setAttr('s:blockId', implicit);
    const p = await reader(200, doc);
    expect(ids(p)[0]).toBe(implicit);
    const writer = new Y.Doc({gc});
    Y.applyUpdate(writer, Y.encodeStateAsUpdate(doc));
    writer.clientID = 8;
    // The second line's marker removed: "two" is a line without one now.
    writer.transact(() => {
      writer.get('lexical-y').delete(7, 1);
    });
    Y.applyUpdate(
      p.doc,
      Y.encodeStateAsUpdate(writer, Y.encodeStateVector(p.doc)),
      NET,
    );
    await idle();
    const text = (x: P) =>
      x.editor.getEditorState().read(() => $getRoot().getTextContent());
    expect(text(p)).toBe('one\n\ntwo');
    // The copy comes first: it keeps the id, the line falls back.
    expect(ids(p)).toEqual([implicit, implicit + '_d']);
    expect(p.writes).toEqual([]);
    const fresh = await reader(201, p.doc);
    expect(text(fresh)).toBe('one\n\ntwo');
    expect(ids(fresh)).toEqual(ids(p));
    expect(fresh.writes).toEqual([]);
  });
}

/** The JSON of a block storing `id`: a paragraph, or a list holding it. */
function copyStoring(id: string, holder: 'paragraph' | 'list item'): unknown {
  const text = {
    detail: 0,
    format: 0,
    mode: 'normal',
    style: '',
    text: 'copy',
    type: 'text',
    version: 1,
  };
  const paragraph = {
    $: {blockId: id},
    children: [text],
    direction: null,
    format: '',
    indent: 0,
    textFormat: 0,
    textStyle: '',
    type: 'paragraph',
    version: 1,
  };
  return holder === 'paragraph'
    ? paragraph
    : {
        children: [
          {
            ...paragraph,
            checked: undefined,
            type: 'listitem',
            value: 1,
          },
        ],
        direction: null,
        format: '',
        indent: 0,
        listType: 'bullet',
        start: 1,
        tag: 'ul',
        type: 'list',
        version: 1,
      };
}

const shownIds = (p: P) =>
  p.editor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .map(n => `${n.getTextContent()}#${$getBlockId(n)}`),
  );

for (const gc of [false, true]) {
  for (const holder of ['paragraph', 'list item'] as const) {
    for (const removal of [
      'deleted by its writer',
      'undone by its writer',
      'deleted by the reader',
    ] as const) {
      test(`a copy of a block's derived id before it (a ${holder}) ${removal} (gc ${gc}): the block shows its derived id again, as a fresh reader does, and its next edit stores it`, async () => {
        // Before: the block kept the `_d` id it fell back to while the copy
        // was there; a fresh reader showed its derived id, and the block's
        // next edit stored the `_d` id for everyone.
        const w = peer(1, false, createYDoc(null, {gc}));
        w.editor.update(
          () => {
            $getRoot()
              .clear()
              .append(
                $createParagraphNode().append($createTextNode('first')),
                $createParagraphNode().append($createTextNode('y')),
                $createParagraphNode().append($createTextNode('last')),
              );
          },
          {discrete: true},
        );
        w.binding.initialize();
        await idle();
        // A writes without ids; B reads with them.
        const a = peer(2, false, createYDoc(null, {gc}), undefined, false);
        deliver(w, a);
        a.binding.initialize();
        const b = await reader(3, w.doc, undefined, false);
        await idle();
        const shown = b.editor
          .getEditorState()
          .read(() => $getBlockId($getRoot().getChildAtIndex(1)!))!;
        // A pastes the JSON of "y" as B shows it before "first".
        a.editor.update(
          () => {
            $getRoot()
              .getFirstChildOrThrow()
              .insertBefore(
                $parseSerializedNode(
                  copyStoring(shown, holder) as SerializedLexicalNode,
                ),
              );
          },
          {discrete: true},
        );
        await idle();
        deliver(a, b);
        await idle();
        expect(shownIds(b)[2]).toBe(`y#${shown}_d`);
        const written = b.writes.length;
        if (removal === 'deleted by its writer') {
          a.editor.update(
            () => {
              $getRoot().getFirstChildOrThrow().remove();
            },
            {discrete: true},
          );
          await idle();
          deliver(a, b);
        } else if (removal === 'undone by its writer') {
          a.binding.undo();
          await idle();
          deliver(a, b);
        } else {
          b.editor.update(
            () => {
              $getRoot().getFirstChildOrThrow().remove();
            },
            {discrete: true},
          );
        }
        await idle();
        expect(shownIds(b)[1]).toBe(`y#${shown}`);
        if (removal !== 'deleted by the reader') {
          expect(b.writes.length).toBe(written);
        }
        const fresh = await reader(4, b.doc, undefined, false);
        expect(shownIds(fresh)).toEqual(shownIds(b));
        // B's next edit of "y" stores the id every client shows.
        b.editor.update(
          () => {
            const t = (
              $getRoot().getChildAtIndex(1) as ElementNode
            ).getFirstChild() as TextNode;
            t.select(1, 1).insertText('!');
          },
          {discrete: true},
        );
        await idle();
        deliver(b, fresh);
        await idle();
        const later = await reader(5, b.doc, undefined, false);
        expect(shownIds(later)[1]).toBe(`y!#${shown}`);
        expect(shownIds(fresh)).toEqual(shownIds(later));
        expect(shownIds(b)).toEqual(shownIds(later));
      });
    }
  }
}

test("a writer without BlockIdExtension changes only the id a box stores, to another box's: the reader settles it as a fresh reader does, and writes nothing", async () => {
  // Before: the attribute change was not noted in the index of who stores
  // what, so both boxes showed the id and BlockIdExtension renamed one in a
  // write on the reader.
  const a = peer(61, false);
  a.editor.update(
    () => {
      const one = $createBoxNode().append(
        $createParagraphNode().append($createTextNode('one')),
      );
      const two = $createBoxNode().append(
        $createParagraphNode().append($createTextNode('two')),
      );
      $setState(one, blockIdState, 'first');
      $setState(two, blockIdState, 'second');
      $getRoot().clear().append(one, two);
    },
    {discrete: true},
  );
  a.binding.initialize();
  await idle();
  const b = await reader(62, a.doc);
  expect(shownIds(b).map(x => x.split('#')[1])).toEqual(['first', 'second']);
  const written = b.writes.length;
  a.editor.update(
    () => {
      $setState($getRoot().getLastChildOrThrow(), blockIdState, 'first');
    },
    {discrete: true},
  );
  await idle();
  deliver(a, b);
  await idle();
  expect(b.writes.length).toBe(written);
  const fresh = await reader(63, a.doc);
  expect(shownIds(b)).toEqual(shownIds(fresh));
  expect(shownIds(b)[0]).toBe('one#first');
  expect(unique(ids(b))).toBe(true);
  expect(fresh.writes).toEqual([]);
});

for (const gc of [false, true]) {
  for (const indenter of [false, true]) {
    test(`lists identified at every level: a reader stores a list's derived id while a writer ${indenter ? 'with' : 'without'} BlockIdExtension indents its item (gc ${gc}): no reader writes, every reader shows the same`, async () => {
      // Before: the nested list kept no id (the one its item stored was the
      // outer list's) and BlockIdExtension named it in a write on every
      // reader.
      const $identified = (n: LexicalNode) =>
        $defaultIsIdentifiedBlock(n) || $isListNode(n);
      const w = peer(71, false, createYDoc(null, {gc}));
      w.editor.update(
        () => {
          $getRoot()
            .clear()
            .append(
              $createListNode('check').append(
                $createListItemNode().append($createTextNode('a')),
              ),
            );
        },
        {discrete: true},
      );
      w.binding.initialize();
      await idle();
      const r = await reader(72, w.doc, $identified, false);
      const i = peer(73, indenter, createYDoc(null, {gc}), $identified, false);
      deliver(w, i);
      i.binding.initialize();
      await idle();
      // Concurrently: R types in the item (storing the ids it shows), I
      // indents it.
      r.editor.update(
        () => {
          $getRoot().getAllTextNodes()[0].select(1, 1).insertText('b');
        },
        {discrete: true},
      );
      i.editor.update(
        () => {
          const item = $getRoot().getAllTextNodes()[0].getParent();
          if ($isListItemNode(item)) {
            (item as ListItemNode).setIndent(1);
          }
        },
        {discrete: true},
      );
      await idle();
      const r2 = await reader(74, w.doc, $identified, false);
      const written = [r.writes.length, r2.writes.length];
      deliver(r, r2);
      await idle();
      deliver(i, r2);
      deliver(i, r);
      deliver(r, i);
      await idle();
      expect([r.writes.length, r2.writes.length]).toEqual(written);
      const fresh = await reader(75, r.doc, $identified, false);
      expect(fresh.writes).toEqual([]);
      expect(ids(r)).toEqual(ids(fresh));
      expect(ids(r2)).toEqual(ids(fresh));
      expect(unique(ids(fresh))).toBe(true);
    });
  }
}

for (const gc of [false, true]) {
  test(`lists identified at every level: Enter in a nested list inside a list stored in an item's line (gc ${gc}): the author shows what every reader shows`, async () => {
    // Before: the nested list derived its id from its first line's marker,
    // which the author's Enter replaced; the author kept the previous id.
    // A list stored as a node derives its id from its own item now.
    const $identified = (n: LexicalNode) =>
      $defaultIsIdentifiedBlock(n) || $isListNode(n);
    const $item = (t: string) =>
      $createListItemNode().append($createTextNode(t));
    const w = peer(81, false, createYDoc(null, {gc}));
    w.editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createListNode('bullet').append($item('a'), $item('c')));
      },
      {discrete: true},
    );
    w.binding.initialize();
    await idle();
    const seeded = Y.encodeStateAsUpdate(w.doc);
    const updates: Uint8Array[] = [];
    w.doc.on('update', (update: Uint8Array) => {
      updates.push(update);
    });
    // Written without transforms: a list (a wrapper item and its nested
    // list) inside item "a"'s line, stored as a node there.
    w.editor.update(
      () => {
        const a = ($getRoot().getFirstChild() as ElementNode).getFirstChild();
        (a as ElementNode).append(
          $createListNode('bullet').append(
            $createListItemNode().append(
              $createListNode('bullet').append($item('b1x'), $item('b2')),
            ),
            $item('d'),
          ),
        );
      },
      {discrete: true, skipTransforms: true},
    );
    await idle();
    // The author has that write, not the writer's normalization of it.
    const doc = createYDoc(null, {gc});
    Y.applyUpdate(doc, seeded, NET);
    Y.applyUpdate(doc, updates[0], NET);
    const author = peer(82, true, doc, $identified, false);
    author.binding.initialize();
    await idle();
    author.editor.update(
      () => {
        const t = $getRoot()
          .getAllTextNodes()
          .find(n => n.getTextContent() === 'b1x')!;
        const selection = t.select(2, 2);
        selection.insertParagraph();
        selection.insertText('NEW');
      },
      {discrete: true},
    );
    await idle();
    const fresh = await reader(83, author.doc, $identified, false);
    expect(ids(author)).toEqual(ids(fresh));
    expect(unique(ids(fresh))).toBe(true);
    expect(fresh.writes).toEqual([]);
  });
}

for (const gc of [false, true]) {
  test(`an item whose group key concurrent edits removed, its group's id kept (gc ${gc}): the list shows the id a fresh reader shows`, async () => {
    // Before: the reader read the item in a list of its own (no group key,
    // so no stored list id) but took the list's stored id from the item's
    // marker when settling, so a reader whose list had shown that id kept
    // it, and a fresh reader showed the derived one.
    const w = peer(91, false, createYDoc(null, {gc}), undefined, false);
    w.editor.update(
      () => {
        const list = $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('a')),
        );
        $setState(list, blockIdState, 'kept');
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('top')), list);
      },
      {discrete: true},
    );
    w.binding.initialize();
    await idle();
    const r = await reader(92, w.doc, undefined, false);
    expect(ids(r)).toContain('kept');
    // Another writer removes the item's group key, as one client's
    // concurrent edit can, leaving the group's own fields.
    const raw = new Y.Doc({gc});
    Y.applyUpdate(raw, Y.encodeStateAsUpdate(w.doc));
    raw.clientID = 93;
    type It = {
      content: {type?: Y.Node};
      deleted: boolean;
      right: It | null;
    };
    const root = raw.get('lexical-y') as unknown as {_start: It | null};
    for (let it = root._start; it !== null; it = it.right) {
      const m = it.content.type;
      if (!it.deleted && m && m.name === '¶' && m.getAttr('g') === 'list') {
        raw.transact(() => m.deleteAttr('g'));
      }
    }
    Y.applyUpdate(
      r.doc,
      Y.encodeStateAsUpdate(raw, Y.encodeStateVector(r.doc)),
      NET,
    );
    await idle();
    const fresh = await reader(94, r.doc, undefined, false);
    expect(ids(r)).toEqual(ids(fresh));
    expect(ids(fresh)).not.toContain('kept');
    expect(fresh.writes).toEqual([]);
  });
}

// A block that a write without the normalization puts inside a line (a
// block decorator, until its author's normalization lifts it out) shows the
// id derived from its item, as a block stored in a container does, so
// BlockIdExtension has nothing to name. A line left without a marker that
// starts with it derives a distinct id (`_l`): both showed one id, and every
// reader of that state wrote a rename (R10-A S1).
for (const gc of [false, true]) {
  for (const markerRemoved of [false, true]) {
    test(`a block decorator written into a line without the normalization${markerRemoved ? ', which loses its marker concurrently' : ''} (gc ${gc}): unique ids, nothing written on a remote change or on load`, async () => {
      const w = peer(1, true, createYDoc(null, {gc}));
      w.editor.update(
        () => {
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append($createTextNode('first')),
              $createParagraphNode().append($createTextNode('last')),
            );
        },
        {discrete: true},
      );
      w.binding.initialize();
      await idle();
      const a = await reader(2, w.doc, undefined, false);
      const b = await reader(3, w.doc, undefined, false);
      if (markerRemoved) {
        a.editor.update(() => $getRoot().getLastChildOrThrow().remove(), {
          discrete: true,
        });
        await idle();
      }
      // B's write, without its normalization (which follows it).
      let raw: Uint8Array | null = null;
      const grab = (update: Uint8Array, origin: unknown) => {
        if (origin !== NET && raw === null) {
          raw = update;
        }
      };
      b.doc.on('update', grab);
      b.editor.update(
        () => {
          $assertNodeType($getRoot().getLastChildOrThrow(), $isElementNode)
            .getFirstChildOrThrow()
            .insertBefore($create(WidgetNode));
        },
        {discrete: true, skipTransforms: true},
      );
      b.doc.off('update', grab);
      expect(raw).not.toBeNull();
      const before = a.writes.length;
      Y.applyUpdate(a.doc, raw!, NET);
      await idle();
      expect(a.writes.slice(before)).toEqual([]);
      expect(unique(ids(a))).toBe(true);
      const fresh = await reader(4, a.doc, undefined, false);
      expect(fresh.writes).toEqual([]);
      expect(ids(fresh)).toEqual(ids(a));
      // B's normalization arrives: every client shows the same.
      deliver(b, a);
      deliver(a, b);
      await idle();
      expect(ids(a)).toEqual(ids(b));
      expect(unique(ids(a))).toBe(true);
    });
  }
}

// A block id set on a line without a marker is written as any other change
// of the line's attributes is (the line gets a marker): the id a reader
// derives for such a line is set by the read, so an id an update changes is
// one set on it. It was left out, so only its author showed it, with or
// without BlockIdExtension (R10-A S3).
for (const authorIds of [false, true]) {
  test(`a block id set on a line without a marker (author ${authorIds ? 'with' : 'without'} BlockIdExtension): every client shows it`, async () => {
    const w = peer(1, false);
    w.editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append($createTextNode('first')),
            $createParagraphNode().append($createTextNode('last')),
          );
      },
      {discrete: true},
    );
    w.binding.initialize();
    await idle();
    const a = await reader(2, w.doc, undefined, false);
    const docB = createYDoc(null, {gc: false});
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(w.doc), NET);
    const b = peer(3, authorIds, docB, undefined, false);
    b.binding.initialize();
    await idle();
    // A removes "last" while B types at its end: B's text keeps no marker.
    a.editor.update(() => $getRoot().getLastChildOrThrow().remove(), {
      discrete: true,
    });
    b.editor.update(
      () => {
        $assertNodeType($getRoot().getLastChildOrThrow(), $isElementNode)
          .selectEnd()
          .insertText('typed');
      },
      {discrete: true},
    );
    await idle();
    deliver(a, b);
    deliver(b, a);
    await idle();
    b.editor.update(
      () => {
        $setState(
          $assertNodeType($getRoot().getLastChildOrThrow(), $isElementNode),
          blockIdState,
          'chosen',
        );
      },
      {discrete: true},
    );
    await idle();
    deliver(b, a);
    await idle();
    const fresh = await reader(4, b.doc, undefined, false);
    const last = (p: P) =>
      p.editor
        .getEditorState()
        .read(() => $getBlockId($getRoot().getLastChildOrThrow()));
    expect([last(b), last(a), last(fresh)]).toEqual([
      'chosen',
      'chosen',
      'chosen',
    ]);
  });
}
