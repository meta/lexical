/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// The keeps a binding sets again after a clear of its undo history (D88)
// across binding lifetimes and app undo managers: a binding that stops
// leaves them to a still bound one that holds them (also after that one
// cleared), and a stop inside a transaction releases them only after it.
import type {YBinding} from '../../..';

import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  type TableNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isTextNode,
  $setSelection,
  type LexicalEditor,
} from 'lexical';
import {expect, test} from 'vitest';

import {createBoundEditor, setup} from '../../utils/harness';
import {$all} from '../../utils/slots';

const $p = (text = 'abcdef ghijkl') =>
  $createParagraphNode().append($createTextNode(text));
const $table = (nested = false, text = 'abcdef ghijkl'): TableNode =>
  $createTableNode().append(
    $createTableRowNode().append(
      $createTableCellNode(0).append(nested ? $table(false, text) : $p(text)),
    ),
  );
const items = (doc: Y.Doc): Y.Item[] =>
  [...doc.store.clients.values()]
    .flat()
    .filter((s): s is Y.Item => s instanceof Y.Item);
function parents(doc: Y.Doc): Y.Item[] {
  const format = items(doc).find(
    s => s.id.client === doc.clientID && s.content instanceof Y.ContentFormat,
  )!;
  const out: Y.Item[] = [];
  for (
    let s = (format.parent as Y.Node)._item;
    s;
    s = (s.parent as Y.Node)._item
  )
    out.push(s);
  return out;
}
function deleteContainer(doc: Y.Doc, table: Y.Item, origin: object) {
  const root = table.parent as Y.Node;
  let index = 0;
  for (let s = root._start; s && s !== table; s = s.right)
    if (!s.deleted && s.countable) index += s.length;
  doc.transact(() => root.delete(index, 1), origin);
}
function $sel(format = false) {
  const texts = $all()
    .filter($isTextNode)
    .filter(n => n.getTextContentSize() >= 4);
  const n = format ? texts[0] : (texts[texts.length - 2] ?? texts[0]);
  const s = $createRangeSelection();
  s.anchor.set(n.getKey(), 1, 'text');
  s.focus.set(n.getKey(), 2, 'text');
  $setSelection(s);
  return s;
}
function edit(
  bound: {editor: LexicalEditor; binding: YBinding},
  format: 'bold' | 'italic' | 'underline' | null,
) {
  bound.binding.undoManager!.stopCapturing();
  bound.editor.update(
    () => {
      if (format) $sel(true).formatText(format);
      else $sel().removeText();
      $setSelection(null);
    },
    {discrete: true},
  );
}
async function fixture(gc: boolean, nested = false) {
  const t = await setup(
    () => $getRoot().append($table(nested), $p('sentinel')),
    {gc},
  );
  edit(t.b, null);
  edit(t.b, 'bold');
  await t.sync();
  return t;
}
function second(t: Awaited<ReturnType<typeof fixture>>, name: string) {
  const b = createBoundEditor(t.b.doc, {
    namespace: name,
    nodes: t.b.nodes,
    onError: e => {
      throw e;
    },
    onWarn: () => {},
    selfCheck: true,
  });
  return {...b, stop: b.start()};
}

// Two binding lifetimes have each re-kept these parents. Both clear while
// alive, removing their normal keepOwners entries. C then holds a real undo
// step for the table via a tracked app origin; B's stop must not release C's
// still-live lifetime's re-keeps. Container GC isolates their consequence.
for (const gc of [false, true])
  for (const sweep of [false, true])
    for (const nested of [false, true])
      for (const during of [false, true])
        test(`live receiver re-keeps survive donor stop gc=${gc} sweep=${sweep} nested=${nested} during=${during}`, async () => {
          const t = await fixture(gc, nested);
          const c = second(t, 'live-receiver');
          try {
            t.b.binding.undoManager!.clear();
            edit(c, null);
            edit(c, 'italic');
            c.binding.undoManager!.clear();
            const appOrigin = {};
            c.binding.undoManager!.addTrackedOrigin(appOrigin);
            // A real app transaction on the shared root, tracked by C's public manager.
            const expectedText = c.editor.read(() =>
              $getRoot().getTextContent(),
            );
            const containers = parents(t.b.doc);
            const table = containers[containers.length - 1];
            const stopDuring = (tr: Y.Transaction) => {
              if (tr.origin === appOrigin) t.b.stop();
            };
            if (during) t.b.doc.on('afterTransaction', stopDuring);
            deleteContainer(t.b.doc, table, appOrigin);
            t.b.doc.off('afterTransaction', stopDuring);
            expect(c.binding.undoManager!.canUndo()).toBe(true);
            if (!during) expect(containers.every(s => s.keep)).toBe(true);
            t.b.stop();
            const after = containers.map(s => s.keep);
            if (sweep && gc)
              t.b.doc.transact(tr =>
                Y.tryGc(
                  tr,
                  t.b.doc.store.ds,
                  s =>
                    s.content instanceof Y.ContentType && t.b.doc.gcFilter(s),
                ),
              );
            c.binding.undoManager!.undo();
            await t.sync();
            const text = c.editor.read(() => $getRoot().getTextContent());
            expect(text).toBe(expectedText);
            expect(after.every(Boolean)).toBe(true);
          } finally {
            c.binding.undoManager!.clear();
            c.stop();
            t.peers.forEach(p => p.stop());
          }
        });

// Stopping inside an app's transaction must preserve the between-transactions
// release boundary even when clear already emptied the binding's normal set.
for (const gc of [false, true])
  test(`last stop inside app deletion uses default GC gc=${gc}`, async () => {
    const t = await setup(() => $getRoot().append($table(), $p('sentinel')), {
      gc,
    });
    const appOrigin = {};
    const app = new Y.UndoManager(t.b.doc, {
      captureTimeout: 0,
      trackedOrigins: new Set([t.b.binding, appOrigin]),
    });
    try {
      edit(t.b, null);
      edit(t.b, 'bold');
      t.b.binding.undoManager!.clear();
      const chain = parents(t.b.doc);
      const table = chain[chain.length - 1];
      const stopDuring = (tr: Y.Transaction) => {
        if (tr.origin === appOrigin) t.b.stop();
      };
      t.b.doc.on('afterTransaction', stopDuring);
      deleteContainer(t.b.doc, table, appOrigin);
      t.b.doc.off('afterTransaction', stopDuring);
      expect(app.undo()).not.toBeNull();
      t.b.stop = t.b.binding.start();
      t.b.binding.initialize();
      await t.sync();
      const text = t.b.read(() => $getRoot().getTextContent());
      expect(text).toContain('acdef ghijkl');
    } finally {
      app.clear();
      app.destroy();
      t.peers.forEach(p => p.stop());
    }
  });
