/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// GPT layout 3 review round 9, M1: a seed written inside an app's outer
// transaction that an app UndoManager tracks: undoing only the layout 3
// record must not leave any update (or the document) without it, so no
// older client ever sees a writable older layout.
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
  test(`R9 D09 seed initialization inside app transaction preserves record in every update gc=${gc}`, async () => {
    const doc = createYDoc(null, {gc});
    doc.clientID = 7;
    const editor = createEditor({
      namespace: 'R9',
      nodes: NODES,
      onError: e => {
        throw e;
      },
      onWarn: () => {},
    });
    const b = new YBinding(editor, doc, {schemaVersion: 1, selfCheck: true});
    b.start();
    editor.update(
      () =>
        $getRoot().append(
          $createParagraphNode().append($createTextNode('ab').setFormat(1)),
        ),
      {discrete: true},
    );
    const app = new Y.UndoManager(doc, {
      captureTimeout: 0,
      deleteFilter: i => i.parentSub === 'lexical-y:3',
      trackedOrigins: new Set(['outer']),
    });
    doc.transact(() => b.initialize(), 'outer');
    await flush();
    const base = Y.encodeStateAsUpdate(doc);
    const updates: Uint8Array[] = [];
    doc.on('update', u => updates.push(u));
    app.undo();
    await flush();
    const receiver = createYDoc(base, {gc});
    const seen: unknown[] = [];
    for (const u of updates) {
      Y.applyUpdate(receiver, u, 'remote');
      seen.push(receiver.get('lexical-y').getAttr('lexical-y:3') ?? null);
    }
    // Every update the undo emits keeps the record (the undo may emit none:
    // the record it captured was already written again), and so does the
    // receiver at the end.
    expect(seen.every(v => v === true)).toBe(true);
    expect(receiver.get('lexical-y').getAttr('lexical-y:3')).toBe(true);
    expect(doc.get('lexical-y').getAttr('lexical-y:3')).toBe(true);
    app.destroy();
    b.dispose();
    doc.destroy();
    receiver.destroy();
  });
