/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A transform registered a second time (unregister and register, as a
// plugin that mounts again does: React StrictMode's second effect run, a
// plugin rendered only while the editor is editable) makes Lexical run
// every transform of that type over the whole document, as the first
// registration did; that update is no one's edit.
// @vitest-environment node

import {
  $createTableCellNode,
  $createTableNodeWithDimensions,
  $insertTableColumnAtSelection,
  $insertTableRowAtSelection,
  registerTablePlugin,
  TableNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type ElementNode,
  ParagraphNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YBinding} from '../..';
import {$p, NODES} from '../utils/harness';

const idle = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

function client(id: number, state?: Uint8Array) {
  const doc = createYDoc(null, {gc: false});
  doc.clientID = id;
  if (state !== undefined) {
    Y.applyUpdate(doc, state, 'load');
  }
  const warnings: string[] = [];
  const editor = createEditor({
    nodes: NODES,
    onError: e => {
      throw e;
    },
    onWarn: e => warnings.push(String(e)),
  });
  const binding = new YBinding(editor, doc, {
    schemaVersion: 1,
    selfCheck: true,
  });
  const stop = binding.start();
  return {
    binding,
    doc,
    editor,
    stop: () => {
      stop();
      doc.destroy();
    },
    warnings,
  };
}
type Client = ReturnType<typeof client>;

const widths = (c: Client) =>
  c.editor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .filter(n => n.getType() === 'table')
      .map(t =>
        (t as ElementNode)
          .getChildren()
          .map(r => (r as ElementNode).getChildrenSize()),
      ),
  );

function $insertIn(i: number, insert: () => unknown): void {
  const table = $getRoot().getChildAtIndex(i) as ElementNode;
  const row = table.getFirstChild() as ElementNode;
  const cell = row.getFirstChild() as ElementNode;
  (cell.getFirstChild() as ElementNode).selectEnd();
  insert();
}

const text = (c: Client) =>
  c.editor.getEditorState().read(() => $getRoot().getTextContent());

/** A stored document holding a ragged table (row insert ‖ column insert). */
function raggedStored(): Uint8Array {
  const a = client(2401);
  a.editor.update(
    () =>
      $getRoot().append($p('top'), $createTableNodeWithDimensions(2, 2, false)),
    {discrete: true},
  );
  a.binding.initialize();
  const base = Y.encodeStateAsUpdate(a.doc);
  const sv = Y.encodeStateVector(a.doc);
  const b = client(2402, base);
  b.binding.initialize();
  a.editor.update(() => $insertIn(1, () => $insertTableRowAtSelection(true)), {
    discrete: true,
  });
  b.editor.update(
    () => $insertIn(1, () => $insertTableColumnAtSelection(true)),
    {discrete: true},
  );
  const relay = new Y.Doc({gc: false});
  Y.applyUpdate(relay, base);
  Y.applyUpdate(relay, Y.encodeStateAsUpdate(a.doc, sv));
  Y.applyUpdate(relay, Y.encodeStateAsUpdate(b.doc, sv));
  const stored = Y.encodeStateAsUpdate(relay);
  a.stop();
  b.stop();
  relay.destroy();
  return stored;
}

const ownItems = (c: Client, id: number) => {
  const structs = c.doc.store.clients.get(id);
  return structs === undefined ? 0 : structs.length;
};

test('control: the first registration of the table plugin pads nothing', async () => {
  const stored = raggedStored();
  const c = client(2403, stored);
  c.binding.initialize();
  try {
    expect(widths(c)).toEqual([[3, 2, 3]]);
    registerTablePlugin(c.editor);
    await idle();
    expect(widths(c)).toEqual([[3, 2, 3]]);
    expect(ownItems(c, 2403)).toBe(0);
  } finally {
    c.stop();
  }
});

test('a TableNode transform remounted beside a mounted table plugin (TableCellResizer toggled by editable) pads nothing', async () => {
  const stored = raggedStored();
  const c = client(2403, stored);
  c.binding.initialize();
  try {
    registerTablePlugin(c.editor);
    await idle();
    const resizer = (t: TableNode) => {
      if (!t.getColWidths()) {
        t.setColWidths(Array(t.getColumnCount()).fill(92));
      }
    };
    let un = c.editor.registerNodeTransform(TableNode, resizer);
    await idle();
    expect(widths(c)).toEqual([[3, 2, 3]]);
    // read-only and back: the resizer unmounts and mounts again
    c.editor.setEditable(false);
    un();
    c.editor.setEditable(true);
    un = c.editor.registerNodeTransform(TableNode, resizer);
    await idle();
    const reader = client(2405, Y.encodeStateAsUpdate(c.doc));
    reader.binding.initialize();
    expect(widths(reader)).toEqual([[3, 2, 3]]);
    expect(widths(c)).toEqual([[3, 2, 3]]);
    reader.stop();
    un();
  } finally {
    c.stop();
  }
});

test('a paragraph transform registered again (StrictMode double effect) inserts nothing', async () => {
  const a = client(2501);
  a.editor.update(() => $getRoot().append($p('one'), $p('two')), {
    discrete: true,
  });
  a.binding.initialize();
  const c = client(2503, Y.encodeStateAsUpdate(a.doc));
  c.binding.initialize();
  try {
    const $t = (node: ParagraphNode) => {
      if (node.getNextSibling() === null && node.getTextContent() !== 'end') {
        node.insertAfter($createParagraphNode().append($createTextNode('end')));
      }
    };
    // StrictMode: effect, cleanup, effect, synchronously.
    const un1 = c.editor.registerNodeTransform(ParagraphNode, $t);
    un1();
    c.editor.registerNodeTransform(ParagraphNode, $t);
    await idle();
    const reader = client(2505, Y.encodeStateAsUpdate(c.doc));
    reader.binding.initialize();
    expect(text(reader)).toBe(text(a));
    expect(ownItems(c, 2503)).toBe(0);
    reader.stop();
  } finally {
    a.stop();
    c.stop();
  }
});

test('the table plugin unregistered and registered again (a remount: one update per transform it registers) pads nothing', async () => {
  const stored = raggedStored();
  const c = client(2403, stored);
  c.binding.initialize();
  try {
    const un = registerTablePlugin(c.editor);
    await idle();
    expect(widths(c)).toEqual([[3, 2, 3]]);
    un();
    registerTablePlugin(c.editor);
    await idle();
    const reader = client(2405, Y.encodeStateAsUpdate(c.doc));
    reader.binding.initialize();
    expect(widths(reader)).toEqual([[3, 2, 3]]);
    expect(widths(c)).toEqual([[3, 2, 3]]);
    expect(ownItems(c, 2403)).toBe(0);
    reader.stop();
  } finally {
    c.stop();
  }
});

test('two clients remount the table plugin at once: the ragged table is padded by neither', async () => {
  const stored = raggedStored();
  const c = client(2403, stored);
  const d = client(2404, stored);
  c.binding.initialize();
  d.binding.initialize();
  try {
    const unC = registerTablePlugin(c.editor);
    const unD = registerTablePlugin(d.editor);
    await idle();
    unC();
    unD();
    registerTablePlugin(c.editor);
    registerTablePlugin(d.editor);
    await idle();
    Y.applyUpdate(c.doc, Y.encodeStateAsUpdate(d.doc));
    Y.applyUpdate(d.doc, Y.encodeStateAsUpdate(c.doc));
    await idle();
    expect(widths(c)).toEqual([[3, 2, 3]]);
    expect(widths(d)).toEqual([[3, 2, 3]]);
    expect(ownItems(c, 2403) + ownItems(d, 2404)).toBe(0);
  } finally {
    c.stop();
    d.stop();
  }
});

test('opening a document whose table stores fewer column widths than its widest row writes nothing', async () => {
  const a = client(2601);
  a.editor.update(
    () => {
      const table = $createTableNodeWithDimensions(2, 3, false);
      table.setColWidths([92, 92, 92]);
      $getRoot().append($p('top'), table);
    },
    {discrete: true},
  );
  a.binding.initialize();
  // A row gets a fourth cell and the widths stay (written without the
  // table plugin's transforms).
  a.editor.update(
    () => {
      const table = $getRoot().getChildAtIndex(1) as ElementNode;
      (table.getFirstChild() as ElementNode).append(
        $createTableCellNode().append($createParagraphNode()),
      );
    },
    {discrete: true, skipTransforms: true},
  );
  await idle();
  const stored = Y.encodeStateAsUpdate(a.doc);
  a.stop();
  const c = client(2602, stored);
  try {
    expect(widths(c)).toEqual([[4, 3]]);
    // The page mounts the table plugin once the document is read: its
    // transform recomputes the widths (and pads the row) in that update.
    registerTablePlugin(c.editor);
    await idle();
    expect(ownItems(c, 2602)).toBe(0);
    const reader = client(2603, Y.encodeStateAsUpdate(c.doc));
    const json = (x: Client) =>
      JSON.stringify(x.editor.getEditorState().toJSON());
    expect(json(c)).toBe(json(reader));
    reader.stop();
  } finally {
    c.stop();
  }
});
