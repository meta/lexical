/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A client that reads a change writes nothing for it: what concurrent edits
// or another client left (ragged tables, many of them at once) is shown as
// stored, the same by every client and by a reader of the whole document,
// also when a transform that would change it is registered later. Also
// initial content still pending when the binding initializes.

import {
  $createTableNodeWithDimensions,
  $insertTableColumnAtSelection,
  $insertTableRowAtSelection,
  registerTablePlugin,
} from '@lexical/table';
import * as Y from '@y/y';
import {$getRoot, createEditor, type ElementNode} from 'lexical';
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

// In table `i`, a row (A) or a column (B) after the first cell.
function $insertIn(i: number, insert: () => unknown): void {
  const table = $getRoot().getChildAtIndex(i) as ElementNode;
  const row = table.getFirstChild() as ElementNode;
  const cell = row.getFirstChild() as ElementNode;
  (cell.getFirstChild() as ElementNode).selectEnd();
  insert();
}

const text = (c: Client) =>
  c.editor.getEditorState().read(() => $getRoot().getTextContent());

test('a change that leaves 300 ragged tables is shown as stored, and its reader writes nothing', async () => {
  const n = 300;
  const a = client(2001);
  a.editor.update(
    () => {
      for (let i = 0; i < n; i++) {
        $getRoot().append($createTableNodeWithDimensions(2, 2, false));
      }
    },
    {discrete: true},
  );
  a.binding.initialize();
  const sv = Y.encodeStateVector(a.doc);
  const b = client(2002, Y.encodeStateAsUpdate(a.doc));
  b.binding.initialize();
  try {
    a.editor.update(
      () => {
        for (let i = 0; i < n; i++) {
          $insertIn(i, () => $insertTableRowAtSelection(true));
        }
      },
      {discrete: true},
    );
    b.editor.update(
      () => {
        for (let i = 0; i < n; i++) {
          $insertIn(i, () => $insertTableColumnAtSelection(true));
        }
      },
      {discrete: true},
    );
    const own = Y.encodeStateVector(a.doc);
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, sv), 'net');
    await idle();
    // Each inserted row lacks the inserted column.
    const w = widths(a);
    expect(w.length).toBe(n);
    expect(w.filter(r => r.join() !== '3,2,3')).toEqual([]);
    expect(a.warnings).toEqual([]);
    // A wrote nothing: B's change only added B's items.
    expect(
      Y.decodeStateVector(Y.encodeStateVector(a.doc)).get(a.doc.clientID),
    ).toBe(Y.decodeStateVector(own).get(a.doc.clientID));
  } finally {
    a.stop();
    b.stop();
  }
}, 60000);

test('a document read in full shows a ragged table a relay stored as stored, and writes nothing', async () => {
  const a = client(2101);
  a.editor.update(
    () => $getRoot().append($createTableNodeWithDimensions(2, 2, false)),
    {discrete: true},
  );
  a.binding.initialize();
  const base = Y.encodeStateAsUpdate(a.doc);
  const sv = Y.encodeStateVector(a.doc);
  const b = client(2102, base);
  b.binding.initialize();
  // A relay with no editor stores both offline edits.
  const relay = new Y.Doc({gc: false});
  Y.applyUpdate(relay, base);
  try {
    a.editor.update(
      () => $insertIn(0, () => $insertTableRowAtSelection(true)),
      {
        discrete: true,
      },
    );
    b.editor.update(
      () => $insertIn(0, () => $insertTableColumnAtSelection(true)),
      {discrete: true},
    );
    Y.applyUpdate(relay, Y.encodeStateAsUpdate(a.doc, sv));
    Y.applyUpdate(relay, Y.encodeStateAsUpdate(b.doc, sv));
    const fresh = client(2103, Y.encodeStateAsUpdate(relay));
    fresh.binding.initialize();
    await idle();
    expect(widths(fresh)).toEqual([[3, 2, 3]]);
    expect(fresh.warnings).toEqual([]);
    expect(fresh.doc.store.clients.has(2103)).toBe(false);
    fresh.stop();
  } finally {
    a.stop();
    b.stop();
    relay.destroy();
  }
});

test('a ragged table a client inserts is shown as stored by the clients that receive it, as a full read shows it', async () => {
  const a = client(2151);
  a.editor.update(() => $getRoot().append($p('base')), {discrete: true});
  a.binding.initialize();
  const b = client(2152, Y.encodeStateAsUpdate(a.doc));
  b.binding.initialize();
  try {
    const sv = Y.encodeStateVector(a.doc);
    // A has no TableExtension (which pads rows): a table with rows of 2 and 1.
    a.editor.update(
      () => {
        const table = $createTableNodeWithDimensions(2, 2, false);
        (
          (table.getLastChild() as ElementNode).getLastChild() as ElementNode
        ).remove();
        $getRoot().append(table);
      },
      {discrete: true},
    );
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, sv), 'net');
    await idle();
    expect(widths(b)).toEqual([[2, 1]]);
    expect(b.doc.store.clients.has(2152)).toBe(false);
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), 'net');
    await idle();
    expect(widths(a)).toEqual([[2, 1]]);
    const fresh = client(2153, Y.encodeStateAsUpdate(a.doc));
    fresh.binding.initialize();
    await idle();
    expect(JSON.stringify(fresh.editor.getEditorState().toJSON())).toBe(
      JSON.stringify(a.editor.getEditorState().toJSON()),
    );
    fresh.stop();
  } finally {
    a.stop();
    b.stop();
  }
});

test('a document read in full writes nothing while read only', async () => {
  const doc = new Y.Doc({gc: false});
  const root = doc.get('lexical-y');
  root.setAttr('lexical-y:99', true);
  const c = client(2201, Y.encodeStateAsUpdate(doc));
  doc.destroy();
  try {
    const sv = Y.encodeStateVector(c.doc);
    c.binding.initialize();
    await idle();
    expect(c.binding.status).toBe('readonly');
    expect(Y.encodeStateVector(c.doc)).toEqual(sv);
  } finally {
    c.stop();
  }
});

test('initial content still pending when the binding initializes is the initial content', async () => {
  const clients = [client(2301), client(2302)];
  try {
    for (const c of clients) {
      // Not discrete: still pending when initialize() runs.
      c.editor.update(() => $getRoot().clear().append($p('SAME')));
      c.binding.initialize();
    }
    await idle();
    for (const c of clients) {
      expect(text(c)).toBe('SAME');
      // Written under the initialization's own client id, not undoable.
      expect(c.doc.store.clients.has(c.doc.clientID)).toBe(false);
      expect(c.binding.undoManager!.canUndo()).toBe(false);
    }
    // Both clients wrote the same items: one copy after an exchange.
    const [a, b] = clients;
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), 'net');
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'net');
    await idle();
    expect(text(a)).toBe('SAME');
    expect(text(b)).toBe('SAME');
  } finally {
    for (const c of clients) {
      c.stop();
    }
  }
});

test('a transform registered after the document was read does not change what was read, and an edit made right after it is written', async () => {
  // A ragged table: a row insert and a column insert at once.
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
  // C reads it, then a plugin that registers the table's transforms mounts
  // (as one that renders once the editor is editable): Lexical runs them over
  // the whole document, which would pad the table.
  const c = client(2403, stored);
  c.binding.initialize();
  // D makes an edit in the same task as that registration.
  const d = client(2404, stored);
  d.binding.initialize();
  try {
    expect(widths(c)).toEqual([[3, 2, 3]]);
    registerTablePlugin(c.editor);
    registerTablePlugin(d.editor);
    d.editor.update(
      () =>
        ($getRoot().getFirstChild() as ElementNode).selectEnd().insertText('!'),
      {discrete: true},
    );
    await idle();
    expect(widths(c)).toEqual([[3, 2, 3]]);
    expect(c.doc.store.clients.has(2403)).toBe(false);
    expect(c.warnings).toEqual([]);
    expect(widths(d)).toEqual([[3, 2, 3]]);
    expect(d.warnings).toEqual([]);
    const reader = client(2405, Y.encodeStateAsUpdate(d.doc));
    reader.binding.initialize();
    expect(text(reader)).toBe(text(d));
    expect(text(d).startsWith('top!')).toBe(true);
    expect(widths(reader)).toEqual([[3, 2, 3]]);
    reader.stop();
  } finally {
    for (const x of [a, b, c, d]) {
      x.stop();
    }
    relay.destroy();
  }
});
