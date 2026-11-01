/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// What a binding keeps, and what it reads again: a new editor bound to a
// document another editor of the same client wrote, a saved EditorState
// restored, a read that recovers by rebuilding the editor, a node type the
// editor does not register inside a list stored as a node, and a layout
// record removed while the root is empty.

import {
  $getBlockId,
  BlockIdExtension,
  buildEditorFromExtensions,
  configExtension,
  defineExtension,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type ElementNode,
  type SerializedTextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, UNKNOWN_NODE_TYPES_WARNING, YCollabExtension} from '../..';
import {Reader} from '../../internal/Read';
import {BoxNode, describeNode, NODES} from '../utils/harness';

type Client = ReturnType<typeof client>;

function client(id: number, blockIds: boolean, doc = createYDoc()) {
  doc.clientID = id;
  const warnings: {code: unknown; message: string}[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        configExtension(YCollabExtension, {doc, schemaVersion: 1}),
        ...(blockIds ? [BlockIdExtension] : []),
      ],
      name: '@lexical/y/test/binding-state',
      nodes: NODES,
      onError: e => {
        throw e;
      },
      onWarn: e => {
        warnings.push({
          code: (e as Error & {code?: unknown}).code,
          message: String(e),
        });
      },
    }),
  );
  const {binding} = getExtensionDependencyFromEditor(
    editor,
    YCollabExtension,
  ).output;
  return {
    binding,
    close: () => {
      editor.dispose();
      doc.destroy();
    },
    doc,
    editor,
    warnings,
  };
}

const idle = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

async function exchange(clients: Client[]) {
  for (let round = 0; round < 3; round++) {
    for (const from of clients) {
      for (const to of clients) {
        if (from !== to) {
          Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc), 'net');
        }
      }
    }
    await idle();
  }
}

async function reader(of: Client, blockIds: boolean): Promise<Client> {
  const r = client(99, blockIds);
  Y.applyUpdate(r.doc, Y.encodeStateAsUpdate(of.doc), 'net');
  r.binding.initialize();
  await idle();
  return r;
}

const describe = (c: Client) =>
  c.editor
    .getEditorState()
    .read(() => $getRoot().getChildren().map(describeNode).join(' / '));

/** The JSON of the last block's children. */
const lastChildren = (c: Client) =>
  c.editor
    .getEditorState()
    .read(() =>
      ($getRoot().getLastChild() as ElementNode)
        .getChildren()
        .map(n => n.exportJSON()),
    );

const lastId = (c: Client) =>
  c.editor.getEditorState().read(() => $getBlockId($getRoot().getLastChild()!));

const $append = (text: string) =>
  ($getRoot().getLastChild() as ElementNode).append(
    $createTextNode(text).setMode('token'),
  );

test('a new editor bound to a document an editor of the same client wrote keeps its text nodes apart', async () => {
  const a = client(1, false);
  const first = client(2, false);
  let second: Client | null = null;
  try {
    a.editor.update(
      () =>
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('base'))),
      {discrete: true},
    );
    a.binding.initialize();
    await exchange([a, first]);
    first.editor.update(() => $append('ONE'), {discrete: true});
    await exchange([a, first]);
    // The same document (and client id) in a new editor: a token it writes
    // must not take the stored identity of the first editor's token.
    first.editor.dispose();
    second = client(2, false, first.doc);
    second.binding.initialize();
    second.editor.update(() => $append('TWO'), {discrete: true});
    await exchange([a, second]);
    const r = await reader(second, false);
    expect(
      lastChildren(second).map(n => (n as SerializedTextNode).text),
    ).toEqual(['base', 'ONE', 'TWO']);
    expect(lastChildren(second)).toEqual(lastChildren(r));
    expect(lastChildren(a)).toEqual(lastChildren(r));
    r.close();
  } finally {
    a.close();
    (second ?? first).close();
  }
});

for (const how of ['another editor', 'the same editor'] as const) {
  test(`a saved EditorState restored with setEditorState is written whole (from ${how})`, async () => {
    const a = client(1, false);
    try {
      a.editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $create(BoxNode).append(
                $createParagraphNode().append($createTextNode('before')),
              ),
            ),
        {discrete: true},
      );
      a.binding.initialize();
      const saved = a.editor.getEditorState();
      let next = saved;
      if (how === 'another editor') {
        // A state built from the saved one keeps the objects of the nodes it
        // did not change (the box), though their descendants changed.
        const fork = createEditor({
          nodes: NODES,
          onError: e => {
            throw e;
          },
        });
        fork.setEditorState(saved);
        fork.update(
          () => $getRoot().getAllTextNodes()[0].setTextContent('after'),
          {discrete: true},
        );
        next = fork.getEditorState();
      } else {
        a.editor.update(
          () => $getRoot().getAllTextNodes()[0].setTextContent('after'),
          {discrete: true},
        );
      }
      a.editor.setEditorState(next);
      await idle();
      const r = await reader(a, false);
      expect(describe(a)).toBe(
        how === 'another editor'
          ? 'test_box(paragraph("after"))'
          : 'test_box(paragraph("before"))',
      );
      expect(describe(r)).toBe(describe(a));
      r.close();
    } finally {
      a.close();
    }
  });
}

/** Make the next remote read throw once, so that the binding recovers. */
function failNextRead(): () => void {
  const saved = Reader.prototype.$apply;
  let once = true;
  Reader.prototype.$apply = function (...args) {
    if (once) {
      once = false;
      throw new Error('read failed');
    }
    return saved.apply(this, args);
  };
  return () => {
    Reader.prototype.$apply = saved;
  };
}

test('a read that recovers keeps the ids lines without a marker derive', async () => {
  const a = client(1, true);
  const b = client(2, true);
  try {
    a.editor.update(
      () =>
        $getRoot().append(
          $createParagraphNode().append($createTextNode('keep')),
          $createParagraphNode().append($createTextNode('gone')),
        ),
      {discrete: true},
    );
    a.binding.initialize();
    await exchange([a, b]);
    const restore = failNextRead();
    try {
      a.editor.update(
        () =>
          ($getRoot().getFirstChild() as ElementNode)
            .selectEnd()
            .insertText('!'),
        {discrete: true},
      );
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'net');
    } finally {
      restore();
    }
    await idle();
    expect(b.warnings.map(w => w.code)).toContain('@lexical/y/recovered-read');
    // A line without a marker: text typed into a paragraph that was removed.
    a.editor.update(() => $getRoot().getLastChild()!.remove(), {
      discrete: true,
    });
    b.editor.update(
      () =>
        ($getRoot().getLastChild() as ElementNode).selectEnd().insertText('XY'),
      {discrete: true},
    );
    await exchange([a, b]);
    const r = await reader(a, true);
    expect(lastId(a)).toMatch(/^y/);
    expect(lastId(b)).toBe(lastId(a));
    expect(lastId(r)).toBe(lastId(a));
    r.close();
  } finally {
    a.close();
    b.close();
  }
});

test('a read that recovers keeps the text nodes it writes next apart from those it read', async () => {
  const a = client(1, false);
  const b = client(2, false);
  try {
    a.editor.update(
      () =>
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('base'))),
      {discrete: true},
    );
    a.binding.initialize();
    await exchange([a, b]);
    b.editor.update(() => $append('ONE'), {discrete: true});
    await exchange([a, b]);
    const restore = failNextRead();
    try {
      a.editor.update(
        () =>
          ($getRoot().getFirstChild() as ElementNode)
            .selectStart()
            .insertText('>'),
        {discrete: true},
      );
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'net');
    } finally {
      restore();
    }
    await idle();
    expect(b.warnings.map(w => w.code)).toContain('@lexical/y/recovered-read');
    b.editor.update(() => $append('TWO'), {discrete: true});
    await exchange([a, b]);
    const r = await reader(b, false);
    expect(lastChildren(b)).toEqual(lastChildren(r));
    expect(lastChildren(a)).toEqual(lastChildren(r));
    expect(lastChildren(r).length).toBe(3);
    r.close();
  } finally {
    a.close();
    b.close();
  }
});

for (const nested of [false, true]) {
  test(`a line of a type the editor does not register makes the binding read only (${nested ? 'inside a list stored as a node' : 'in the root'})`, async () => {
    const doc = createYDoc(null, {gc: false});
    doc.clientID = 700;
    const root = doc.get('lexical-y');
    root.setAttr('lexical-y:1', true);
    root.setAttr('k:unregistered_line', 'line');
    if (!nested) {
      root.insert(0, 'secret');
      const marker = new Y.Node('¶');
      root.insert(6, [marker]);
      marker.setAttr('t', 'unregistered_line');
    } else {
      // A list stored inside a list item's line, as a node of its own.
      root.setAttr('k:list', 'group|listType');
      root.setAttr('k:listitem', 'line');
      root.insert(0, 'outer');
      const inner = new Y.Node('i:list');
      root.insert(5, [inner]);
      inner.setAttr('c', 'b');
      inner.setAttr('p:listType', 'bullet');
      inner.insert(0, 'secret');
      const marker = new Y.Node('¶');
      inner.insert(6, [marker]);
      marker.setAttr('t', 'unregistered_line');
      const outer = new Y.Node('¶');
      root.insert(6, [outer]);
      outer.setAttr('t', 'listitem');
      outer.setAttr('g', 'list');
      outer.setAttr('g:listType', 'bullet');
    }
    const c = client(701, false, doc);
    try {
      await idle();
      expect(c.binding.status).toBe('readonly');
      expect(c.warnings.map(w => w.code)).toContain(UNKNOWN_NODE_TYPES_WARNING);
      const before = Y.encodeStateVector(c.doc);
      c.editor.update(
        () => {
          const text = $getRoot()
            .getAllTextNodes()
            .find(n => n.getTextContent() === 'secret');
          text?.select(6, 6).insertText('!');
        },
        {discrete: true},
      );
      expect(Y.encodeStateVector(c.doc)).toEqual(before);
    } finally {
      c.close();
    }
  });
}

test('removing the layout record while the root is empty makes the binding read only', async () => {
  const c = client(901, false);
  const remote = new Y.Doc();
  try {
    c.binding.initialize();
    c.editor.update(() => $getRoot().clear(), {discrete: true});
    expect(c.doc.get('lexical-y').length).toBe(0);
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(c.doc));
    remote.clientID = 902;
    remote.get('lexical-y').deleteAttr('lexical-y:1');
    Y.applyUpdate(c.doc, Y.encodeStateAsUpdate(remote), 'net');
    await idle();
    expect(c.binding.status).toBe('readonly');
    const before = Y.encodeStateVector(c.doc);
    c.editor.update(
      () =>
        $getRoot().append(
          $createParagraphNode().append($createTextNode('local')),
        ),
      {discrete: true},
    );
    expect(Y.encodeStateVector(c.doc)).toEqual(before);
  } finally {
    c.close();
    remote.destroy();
  }
});
