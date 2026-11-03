/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// GPT layout 3 review round 10, MUST 1 (a regression of 4037b157a): a
// request to protect a seed's record belongs to the transaction that wrote
// it; nothing is left on the root for a later binding to act on, so a
// read-only binding of the older root writes nothing on an unrelated
// remote update.
import * as Y from '@y/y';
import {$getRoot, createEditor} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YBinding} from '../..';
import {$p, flush, NODES} from '../utils/harness';

for (const gc of [false, true])
  test(`R10 deferred seed record does not survive as a stale root flag gc=${gc}`, async () => {
    const doc = createYDoc(null, {gc});
    const root = doc.get('lexical-y');
    const e = createEditor({
      nodes: NODES,
      onError: x => {
        throw x;
      },
      onWarn: () => {},
    });
    const b = new YBinding(e, doc, {schemaVersion: 1});
    b.start();
    e.update(() => $getRoot().append($p('abc')), {discrete: true});
    const app = new Y.UndoManager(root, {
      captureTimeout: 0,
      deleteFilter: i => i.parentSub === 'lexical-y:3',
      trackedOrigins: new Set(['outer']),
    });
    doc.transact(() => {
      b.initialize();
      b.dispose();
    }, 'outer');
    app.undo();
    await flush();
    // The record survives the undo (written again untracked after the outer
    // transaction, the binding disposed or not); remove it for this check.
    expect(root.getAttr('lexical-y:3')).toBe(true);
    doc.transact(() => root.deleteAttr('lexical-y:3'), 'raw');
    expect(root.getAttr('lexical-y:3')).toBeUndefined();
    const e2 = createEditor({
      nodes: NODES,
      onError: x => {
        throw x;
      },
      onWarn: () => {},
    });
    const b2 = new YBinding(e2, doc, {schemaVersion: 1});
    b2.start();
    b2.initialize();
    expect(b2.status).toBe('readonly');
    const clock = doc.store.getClock(doc.clientID);
    const incoming = new Y.Doc();
    incoming.clientID = 901;
    incoming.get('activity').setAttr('event', true);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(incoming), 'remote');
    incoming.destroy();
    const after = root.getAttr('lexical-y:3') ?? null;
    expect(after).toBeNull();
    // The read-only binding wrote nothing.
    expect(doc.store.getClock(doc.clientID)).toBe(clock);
    app.destroy();
    b2.dispose();
    doc.destroy();
  });
