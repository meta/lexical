/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// While the binding is bound, a clear of its undo history leaves kept what
// another undo manager on the document (an app's, or a second binding's)
// still needs: B deletes a character in a table cell and bolds text there,
// then removes the table; after B's clear the table, row and cell items
// stay kept, and the other manager's undo brings the text back.
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
} from 'lexical';
import {expect, test} from 'vitest';

import {$selectIn, createBoundEditor, setup} from '../../utils/harness';

for (const gc of [false, true]) {
  for (const other of ['app', 'second-binding-manager'] as const) {
    test(`a clear leaves kept what another undo manager needs (${other}, gc ${gc ? 'on' : 'off'})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createTableNode().append(
              $createTableRowNode().append(
                $createTableCellNode(0).append(
                  $createParagraphNode().append(
                    $createTextNode('abcdef ghijkl'),
                  ),
                ),
              ),
            ),
            $createParagraphNode().append($createTextNode('sentinel')),
          ),
        {gc},
      );
      const second =
        other === 'second-binding-manager'
          ? createBoundEditor(t.b.doc, {
              namespace: 'second',
              nodes: t.b.nodes,
              onError: e => {
                throw e;
              },
              onWarn: () => {},
              selfCheck: true,
            })
          : null;
      const stopSecond = second?.start();
      const app =
        second?.binding.undoManager ??
        new Y.UndoManager(t.b.doc, {
          captureTimeout: 0,
          trackedOrigins: new Set([t.b.binding]),
        });
      app.addTrackedOrigin(t.b.binding);
      app.captureTimeout = 0;
      try {
        t.b.update(() => {
          $selectIn([0, 0, 0, 0], 1, 2).removeText();
          $setSelection(null);
        });
        t.b.update(() => {
          $selectIn([0, 0, 0, 0], 1, 2).formatText('bold');
          $setSelection(null);
        });
        const ownFormat = [...t.b.doc.store.clients.values()]
          .flat()
          .find(
            s =>
              s instanceof Y.Item &&
              s.id.client === t.b.doc.clientID &&
              s.content instanceof Y.ContentFormat,
          ) as Y.Item;
        const parents: Y.Item[] = [];
        for (
          let it = (ownFormat.parent as Y.Node)._item;
          it;
          it = (it.parent as Y.Node)._item
        )
          parents.push(it);
        expect(parents).toHaveLength(3);
        t.b.update(() => {
          $getRoot().getFirstChildOrThrow().remove();
          $setSelection(null);
        });
        expect(parents.every(it => it.keep && it.deleted)).toBe(true);
        t.b.binding.undoManager!.clear();
        const after = parents.map(it => it.keep);
        app.undo();
        await t.sync();
        const text = t.b.read(() => $getRoot().getTextContent());
        expect(text).toContain('acdef ghijkl');
        expect(after).toEqual([true, true, true]);
      } finally {
        app.clear();
        stopSecond?.();
        app.destroy();
        t.peers.forEach(p => p.stop());
      }
    });
  }
}
