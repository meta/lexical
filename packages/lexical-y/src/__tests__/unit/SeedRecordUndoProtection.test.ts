/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The seed's layout 3 record stays
// live in every update an app UndoManager's undo emits, whether the app
// tracks every plain-object origin (initialization outside an outer
// transaction) or the outer transaction the initialization ran in (with the
// binding disposed before it ends), top-level and nested roots.
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YBinding} from '../..';
import {flush, NODES} from '../utils/harness';

for (const gc of [false, true])
  for (const nested of [false, true])
    for (const mode of ['Object capture', 'dispose in outer'] as const) {
      test(`seed protection ${mode} nested=${nested} gc=${gc}`, async () => {
        const doc = createYDoc(null, {gc});
        doc.clientID = 7;
        const root = nested ? new Y.Node('editor-root') : doc.get('lexical-y');
        if (nested) doc.get('app').setAttr('editor', root);
        const editor = createEditor({
          namespace: 'test',
          nodes: NODES,
          onError: e => {
            throw e;
          },
          onWarn: () => {},
        });
        const b = new YBinding(editor, doc, {
          root,
          schemaVersion: 1,
          selfCheck: true,
        });
        b.start();
        editor.update(
          () =>
            $getRoot().append(
              $createParagraphNode().append($createTextNode('ab').setFormat(1)),
            ),
          {discrete: true},
        );
        const app = new Y.UndoManager(root, {
          captureTimeout: 0,
          deleteFilter: i => i.parentSub === 'lexical-y:4',
          trackedOrigins: new Set<unknown>([
            mode === 'Object capture' ? Object : 'outer',
          ]),
        });
        if (mode === 'Object capture') b.initialize();
        else
          doc.transact(() => {
            b.initialize();
            b.dispose();
          }, 'outer');
        await flush();
        const base = Y.encodeStateAsUpdate(doc);
        const updates: Uint8Array[] = [];
        doc.on('update', u => updates.push(u));
        app.undo();
        await flush();
        const receiver = createYDoc(base, {gc});
        const rroot = nested
          ? (receiver.get('app').getAttr('editor') as Y.Node)
          : receiver.get('lexical-y');
        const seen: unknown[] = [];
        for (const u of updates) {
          Y.applyUpdate(receiver, u, 'remote');
          seen.push(rroot.getAttr('lexical-y:4') ?? null);
        }
        expect(seen.every(v => v === true)).toBe(true);
        expect(root.getAttr('lexical-y:4')).toBe(true);
        app.destroy();
        b.dispose();
        doc.destroy();
        receiver.destroy();
      });
    }
