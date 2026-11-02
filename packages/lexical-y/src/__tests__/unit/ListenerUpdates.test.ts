/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Updates that code queues from an update listener (an app's own edit, the
// character limit's wrapping) are that client's edits: they are written,
// also when Lexical commits them with an update of the binding's own, and
// when a remote change is applied in the same task. Updates that follow a
// commit on every client (BlockIdExtension's naming, a transform registered
// while the document is open) may set attributes or delete; anything else
// they change is read again, so that the editor shows the document.

import {
  BlockIdExtension,
  buildEditorFromExtensions,
  configExtension,
  defineExtension,
  getExtensionDependencyFromEditor,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  type ListNode,
} from '@lexical/list';
import {$createOverflowNode, OverflowNode} from '@lexical/overflow';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $isTableNode,
  $isTableRowNode,
  TableNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isParagraphNode,
  $isRootNode,
  $isTextNode,
  $setCompositionKey,
  type ElementNode,
  ParagraphNode,
  type TextNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {afterEach, beforeEach, expect, test} from 'vitest';

import {createYDoc, type YBinding, YCollabExtension} from '../..';
import {BoxNode, describeNode, NODES} from '../utils/harness';

type Client = {
  doc: Y.Doc;
  editor: LexicalEditorWithDispose;
  binding: YBinding;
  warnings: string[];
};

// Development warnings of the binding (a follow-up's change it does not
// write) go to console.warn.
const consoleWarnings: string[] = [];
const consoleWarn = console.warn;
beforeEach(() => {
  consoleWarnings.length = 0;
  console.warn = (...args: unknown[]) => {
    consoleWarnings.push(args.map(String).join(' '));
  };
});
afterEach(() => {
  console.warn = consoleWarn;
});

function client(
  id: number,
  options: {blockIds?: boolean; repairTransforms?: boolean} = {},
): Client {
  const doc = createYDoc(null, {gc: false});
  doc.clientID = id;
  const warnings: string[] = [];
  let n = 0;
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        configExtension(YCollabExtension, {
          doc,
          schemaVersion: 1,
          selfCheck: true,
        }),
        ...(options.blockIds === true
          ? [
              configExtension(BlockIdExtension, {
                generateId: () => `id${id}x${++n}`,
                ...(options.repairTransforms === undefined
                  ? {}
                  : {repairTransforms: options.repairTransforms}),
              }),
            ]
          : []),
      ],
      name: '@lexical/y/test/listener-updates',
      nodes: [...NODES, OverflowNode],
      onError: e => {
        throw e;
      },
      onWarn: e => {
        warnings.push(String(e));
      },
    }),
  );
  const {binding} = getExtensionDependencyFromEditor(
    editor,
    YCollabExtension,
  ).output;
  return {binding, doc, editor, warnings};
}

const idle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

const send = (from: Client, to: Client) =>
  Y.applyUpdate(
    to.doc,
    Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)),
    'net',
  );

async function exchange(clients: Client[]) {
  for (let round = 0; round < 3; round++) {
    for (const from of clients) {
      for (const to of clients) {
        if (from !== to) {
          send(from, to);
        }
      }
    }
    await idle();
  }
}

const describe = (c: Client) =>
  c.editor
    .getEditorState()
    .read(() => $getRoot().getChildren().map(describeNode).join(' / '));

async function start(clients: Client[], $init: () => void) {
  const [a] = clients;
  a.editor.update(
    () => {
      $getRoot().clear();
      $init();
    },
    {discrete: true},
  );
  a.binding.initialize();
  for (const c of clients.slice(1)) {
    Y.applyUpdate(c.doc, Y.encodeStateAsUpdate(a.doc), 'net');
    c.binding.initialize();
  }
  await exchange(clients);
}

/** Every client and a reader of the document show `expected`. */
async function expectShown(
  clients: Client[],
  expected: string,
  blockIds = false,
) {
  const reader = client(99, {blockIds});
  Y.applyUpdate(reader.doc, Y.encodeStateAsUpdate(clients[0].doc), 'net');
  reader.binding.initialize();
  await idle();
  for (const c of [...clients, reader]) {
    expect(describe(c)).toBe(expected);
    expect(c.warnings).toEqual([]);
    expect(JSON.stringify(c.editor.getEditorState().toJSON())).toBe(
      JSON.stringify(clients[0].editor.getEditorState().toJSON()),
    );
  }
  reader.editor.dispose();
}

const $list = () =>
  $createListNode('number').append(
    $createListItemNode().append($createTextNode('a')),
    $createListItemNode().append($createTextNode('b')),
  );

for (const blockIds of [false, true]) {
  test(`an update an app's listener queues after a list change is written (block ids: ${blockIds})`, async () => {
    const a = client(1, {blockIds});
    const b = client(2, {blockIds});
    await start([a, b], () =>
      $getRoot().append(
        $list(),
        $createParagraphNode().append($createTextNode('p')),
      ),
    );
    // The app makes an edit of its own after the next local change; Lexical
    // commits it with the update the binding makes after a list changes.
    let armed = true;
    a.editor.registerUpdateListener(({tags}) => {
      if (armed && !tags.has('collaboration')) {
        armed = false;
        a.editor.update(() => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('APP')),
          );
        });
      }
    });
    a.editor.update(
      () =>
        ($getRoot().getFirstChild() as ListNode)
          .getLastChild()!
          .insertAfter($createListItemNode().append($createTextNode('c'))),
      {discrete: true},
    );
    await idle();
    await exchange([a, b]);
    await expectShown(
      [a, b],
      'list[number](listitem("a") listitem("b") listitem("c")) / paragraph("p") / paragraph("APP")',
      blockIds,
    );
    expect(consoleWarnings).toEqual([]);
  });
}

test("an update an app's listener queues when a composition ends is written, with the remote text held back until then", async () => {
  const a = client(1);
  const b = client(2);
  await start([a, b], () =>
    $getRoot().append(
      $createParagraphNode().append($createTextNode('hello')),
      $createParagraphNode().append($createTextNode('world')),
    ),
  );
  const $first = () =>
    ($getRoot().getFirstChild() as ElementNode).getFirstChild() as TextNode;
  a.editor.update(
    () => {
      $first().select(5, 5);
      $setCompositionKey($first().getKey());
    },
    {discrete: true},
  );
  // B types in the line A composes in: A shows it when the composition ends.
  b.editor.update(() => $first().select(0, 0).insertText('X'), {
    discrete: true,
  });
  send(b, a);
  await idle();
  a.editor.update(
    () => {
      const t = $first();
      t.setTextContent(t.getTextContent() + 'あ');
      t.select(t.getTextContentSize(), t.getTextContentSize());
    },
    {discrete: true},
  );
  let armed = true;
  a.editor.registerUpdateListener(({tags}) => {
    if (
      armed &&
      !tags.has('collaboration') &&
      a.editor._compositionKey === null
    ) {
      armed = false;
      a.editor.update(() => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('APP')),
        );
      });
    }
  });
  a.editor.update(() => $setCompositionKey(null), {discrete: true});
  await idle();
  await exchange([a, b]);
  await expectShown(
    [a, b],
    'paragraph("Xhelloあ") / paragraph("world") / paragraph("APP")',
  );
});

test('an overflow wrapping queued from a listener after a list change is written', async () => {
  const a = client(1);
  const b = client(2);
  await start([a, b], () =>
    $getRoot().append(
      $list(),
      $createParagraphNode().append($createTextNode('some text')),
    ),
  );
  // As the character limit does: after a local change, a listener queues an
  // update that wraps the text over the limit in an OverflowNode.
  let armed = true;
  a.editor.registerUpdateListener(({tags}) => {
    if (armed && !tags.has('collaboration')) {
      armed = false;
      a.editor.update(
        () => {
          const text = (
            $getRoot().getLastChild() as ElementNode
          ).getFirstChild();
          if ($isTextNode(text)) {
            const [, over] = text.splitText(4);
            const overflow = $createOverflowNode();
            over.insertBefore(overflow);
            overflow.append(over);
          }
        },
        {tag: 'history-merge'},
      );
    }
  });
  a.editor.update(
    () =>
      ($getRoot().getFirstChild() as ListNode)
        .getLastChild()!
        .insertAfter($createListItemNode().append($createTextNode('c'))),
    {discrete: true},
  );
  await idle();
  await exchange([a, b]);
  await expectShown(
    [a, b],
    'list[number](listitem("a") listitem("b") listitem("c")) / paragraph("some" overflow(" text"))',
  );
  expect(consoleWarnings).toEqual([]);
});

test("an update an app's listener queues is written when a remote change to its line is applied in the same task", async () => {
  const a = client(1);
  const b = client(2);
  await start([a, b], () =>
    $getRoot().append(
      $createParagraphNode().append($createTextNode('one')),
      $createParagraphNode().append($createTextNode('hello world')),
    ),
  );
  // B splits the line the app's update appends to.
  b.editor.update(
    () =>
      $assertNodeType(
        ($getRoot().getLastChild() as ElementNode).getFirstChild(),
        $isTextNode,
      )
        .select(5, 5)
        .insertParagraph(),
    {discrete: true},
  );
  let armed = true;
  a.editor.registerUpdateListener(({tags}) => {
    if (armed && !tags.has('collaboration')) {
      armed = false;
      a.editor.update(() =>
        ($getRoot().getLastChild() as ElementNode).append($createTextNode('!')),
      );
    }
  });
  a.editor.update(
    () =>
      $assertNodeType(
        ($getRoot().getFirstChild() as ElementNode).getFirstChild(),
        $isTextNode,
      )
        .select(3, 3)
        .insertText('1'),
    {discrete: true},
  );
  // The provider applies B's change before the app's update could commit in
  // a microtask.
  send(b, a);
  await idle();
  await exchange([a, b]);
  await expectShown(
    [a, b],
    'paragraph("one1") / paragraph("hello") / paragraph(" world!")',
  );
});

test('with repairTransforms: true, the binding fails closed: a warning, read only, nothing written', async () => {
  const a = client(1, {blockIds: true});
  await start([a], () =>
    $getRoot().append($createParagraphNode().append($createTextNode('base'))),
  );
  // BlockIdExtension's naming update would run transforms over what remote
  // changes bring, which the binding does not write.
  const b = client(2, {blockIds: true, repairTransforms: true});
  const written: Uint8Array[] = [];
  b.doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'net') {
      written.push(update);
    }
  });
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'net');
  b.binding.initialize();
  await idle();
  expect(b.binding.status).toBe('readonly');
  expect(b.editor.isEditable()).toBe(false);
  expect(b.warnings).toHaveLength(1);
  expect(b.warnings[0]).toContain('BlockIdExtension.repairTransforms');
  // It shows the document and follows it, and writes nothing.
  expect(describe(b)).toBe('paragraph("base")');
  a.editor.update(
    () =>
      $getRoot().append($createParagraphNode().append($createTextNode('more'))),
    {discrete: true},
  );
  send(a, b);
  await idle();
  expect(describe(b)).toBe('paragraph("base") / paragraph("more")');
  // A local update is not written either: what it changed is read again,
  // with a warning.
  b.editor.update(
    () =>
      $getRoot().append($createParagraphNode().append($createTextNode('x'))),
    {discrete: true},
  );
  await idle();
  expect(written).toEqual([]);
  expect(describe(b)).toBe('paragraph("base") / paragraph("more")');
  expect(b.warnings).toHaveLength(2);
  expect(b.warnings[1]).toContain('read only');
});

test('with repairTransforms: true, the initial content is not written', async () => {
  const a = client(1, {blockIds: true, repairTransforms: true});
  a.editor.update(
    () =>
      $getRoot().append($createParagraphNode().append($createTextNode('seed'))),
    {discrete: true},
  );
  a.binding.initialize();
  await idle();
  expect(a.binding.status).toBe('readonly');
  expect(a.binding.root.length).toBe(0);
  expect(Y.encodeStateVector(a.doc)).toEqual(Y.encodeStateVector(new Y.Doc()));
  expect(a.warnings.map(w => w.includes('repairTransforms'))).toEqual([true]);
});

test('a transform registered while the document is open writes nothing, deletions included: the editor reads the document again', async () => {
  const a = client(1);
  const b = client(2);
  await start([a, b], () =>
    $getRoot().append(
      $createParagraphNode().append($createTextNode('one')),
      $createParagraphNode().append($createTextNode('drop')),
      $createParagraphNode().append($createTextNode('three')),
    ),
  );
  // Lexical runs a transform registered now over the whole document.
  a.editor.registerNodeTransform(ParagraphNode, node => {
    if (node.getTextContent() === 'drop') {
      node.remove();
    }
  });
  await idle();
  await exchange([a, b]);
  // Opening a document is no one's edit: the update Lexical makes when the
  // transform is registered is not written, and A shows the document.
  await expectShown(
    [a, b],
    'paragraph("one") / paragraph("drop") / paragraph("three")',
  );
  expect(consoleWarnings).toEqual([]);
});

test('a change the binding did not write is read again before anything else, and a remote change is read on the document', async () => {
  const a = client(1);
  const b = client(2);
  await start([a, b], () =>
    $getRoot().append($createParagraphNode().append($createTextNode('one'))),
  );
  a.editor.registerNodeTransform(ParagraphNode, node => {
    if ($isRootNode(node.getParent())) {
      const box = $create(BoxNode);
      node.insertBefore(box);
      box.append(node);
    }
  });
  // The paragraph moved into a box by A's new transform is not written: A
  // reads the document again as the next update, before the registration
  // returns.
  expect(describe(a)).toBe('paragraph("one")');
  b.editor.update(
    () => {
      const text = $assertNodeType(
        $getRoot().getFirstChildOrThrow(),
        $isParagraphNode,
      );
      $assertNodeType(text.getFirstChildOrThrow(), $isTextNode).setTextContent(
        'oneX',
      );
    },
    {discrete: true},
  );
  Y.applyUpdate(
    a.doc,
    Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)),
    'net',
  );
  expect(describe(a)).toBe('paragraph("oneX")');
  await exchange([a, b]);
  await expectShown([a, b], 'paragraph("oneX")');
});

test('a transform registered while the document is open does not insert: the editor reads the document again', async () => {
  const a = client(1);
  const b = client(2);
  await start([a, b], () =>
    $getRoot().append($createParagraphNode().append($createTextNode('one'))),
  );
  const before = Y.encodeStateVector(a.doc);
  a.editor.registerNodeTransform(ParagraphNode, node => {
    if (node.getNextSibling() === null && node.getTextContent() !== 'end') {
      node.insertAfter($createParagraphNode().append($createTextNode('end')));
    }
  });
  await idle();
  expect(Y.encodeStateVector(a.doc)).toEqual(before);
  await exchange([a, b]);
  await expectShown([a, b], 'paragraph("one")');
  // Expected of a transform registered while the document is open: no
  // development warning.
  expect(consoleWarnings).toEqual([]);
});

test('a table plugin that pads a ragged table when it mounts writes nothing and warns nothing', async () => {
  const a = client(1);
  const b = client(2);
  const $cell = (text: string) =>
    $createTableCellNode().append(
      $createParagraphNode().append($createTextNode(text)),
    );
  await start([a, b], () =>
    $getRoot().append(
      $createTableNode().append(
        $createTableRowNode().append($cell('a'), $cell('b')),
        $createTableRowNode().append($cell('c')),
      ),
    ),
  );
  const before = Y.encodeStateVector(a.doc);
  // What a table plugin's transform does to a ragged table (a row insert
  // racing a column insert leaves one).
  a.editor.registerNodeTransform(TableNode, table => {
    for (const row of table
      .getChildren()
      .map(node => $assertNodeType(node, $isTableRowNode))) {
      while (row.getChildrenSize() < 2) {
        row.append($cell(''));
      }
    }
  });
  await idle();
  expect(Y.encodeStateVector(a.doc)).toEqual(before);
  await exchange([a, b]);
  const shape = (c: Client) =>
    c.editor.read(() =>
      $assertNodeType($getRoot().getFirstChildOrThrow(), $isTableNode)
        .getChildren()
        .map(node => $assertNodeType(node, $isTableRowNode))
        .map(row => row.getChildrenSize()),
    );
  expect(shape(a)).toEqual([2, 1]);
  expect(shape(b)).toEqual([2, 1]);
  expect(consoleWarnings).toEqual([]);
});

for (const blockIds of [false, true]) {
  test(`an update an app's listener queues behind a change the binding did not write is written on the document (block ids: ${blockIds})`, async () => {
    const a = client(1, {blockIds});
    const b = client(2, {blockIds});
    await start([a, b], () =>
      $getRoot().append($createParagraphNode().append($createTextNode('one'))),
    );
    // In the listener phase of the commit that holds the change the binding
    // does not write (a transform registered now inserts a paragraph), an
    // app's listener queues an edit of its own: it is applied to the
    // document, not to the editor still showing the paragraph.
    let armed = true;
    a.editor.registerUpdateListener(() => {
      if (armed) {
        armed = false;
        a.editor.update(() => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('app')),
          );
        });
      }
    });
    a.editor.registerNodeTransform(ParagraphNode, node => {
      if (node.getNextSibling() === null && node.getTextContent() === 'one') {
        node.insertAfter($createParagraphNode().append($createTextNode('end')));
      }
    });
    expect(armed).toBe(false);
    expect(describe(a)).toBe('paragraph("one") / paragraph("app")');
    await idle();
    await exchange([a, b]);
    await expectShown([a, b], 'paragraph("one") / paragraph("app")', blockIds);
    expect(
      consoleWarnings.filter(w => w.includes('follow-up update changed')),
    ).toEqual([]);
  });
}
