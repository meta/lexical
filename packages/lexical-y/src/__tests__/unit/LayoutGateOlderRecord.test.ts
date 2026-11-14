/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A document that records only a
// layout older than 3 is never written, whether it was older from the start
// or a remote change downgraded it while the binding was active; and the
// 'older' UNSUPPORTED_LAYOUT_WARNING comes once per read-only period.
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
} from 'lexical';
import {expect, test} from 'vitest';

import {
  createYDoc,
  UNSUPPORTED_LAYOUT_WARNING,
  YBinding,
  type YWarning,
} from '../..';
import {editYState} from '../../headless';
import {$p, flush, NODES, setup} from '../utils/harness';

/** The `[found, min]` of each 'older' UNSUPPORTED_LAYOUT_WARNING. */
const olderOf = (warnings: unknown[]): number[][] =>
  (warnings as YWarning[])
    .filter(
      w =>
        w.code === UNSUPPORTED_LAYOUT_WARNING &&
        (w.data as {reason?: string}).reason === 'older',
    )
    .map(w => {
      const data = w.data as {found: number; min: number};
      return [data.found, data.min];
    });

for (const gc of [false, true]) {
  test(`the 'older' warning reports each readonly period gc=${gc}`, async () => {
    const doc = createYDoc(null, {gc});
    doc.clientID = 7;
    doc.get('lexical-y').setAttr('lexical-y:1', true);
    const warned: unknown[] = [];
    const e = createEditor({
      namespace: 'test',
      nodes: NODES,
      onError: x => {
        throw x;
      },
      onWarn: w => warned.push(w),
    });
    const b = new YBinding(e, doc, {
      layoutUpgrade: null,
      schemaVersion: 1,
    });
    b.start();
    b.initialize();
    await flush();
    const incoming = (fn: (r: Y.Node) => void) => {
      const rdoc = createYDoc(Y.encodeStateAsUpdate(doc), {gc});
      const sv = Y.encodeStateVector(rdoc);
      rdoc.transact(() => fn(rdoc.get('lexical-y')));
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(rdoc, sv), 'remote');
      rdoc.destroy();
    };
    incoming(r => r.setAttr('lexical-y:5', true));
    expect(b.status).toBe('active');
    incoming(r => r.setAttr('lexical-y:999', true));
    expect(b.status).toBe('readonly');
    incoming(r => {
      r.deleteAttr('lexical-y:999');
      r.deleteAttr('lexical-y:5');
    });
    await flush();
    expect(olderOf(warned)).toEqual([
      [1, 5],
      [1, 5],
    ]);
    b.dispose();
    doc.destroy();
  });
  for (const layout of [1, 2, 3]) {
    test(`remote layout downgrade closes active writer layout=${layout} gc=${gc}`, async () => {
      const t = await setup(() => $getRoot().append($p('abc')), {gc});
      const remote = createYDoc(Y.encodeStateAsUpdate(t.a.doc), {gc});
      remote.clientID = 80;
      const sv = Y.encodeStateVector(remote);
      remote.transact(() => {
        // A new document records layout 4 only: the older record is set.
        remote.get('lexical-y').deleteAttr('lexical-y:5');
        remote.get('lexical-y').setAttr('lexical-y:' + layout, true);
      });
      Y.applyUpdate(t.a.doc, Y.encodeStateAsUpdate(remote, sv), t.a.net);
      await flush();
      const before = Y.encodeStateAsUpdate(t.a.doc);
      const status = t.a.binding.status;
      t.a.update(() => $getRoot().append($p('forbidden')));
      await flush();
      expect(status).toBe('readonly');
      expect(Y.encodeStateAsUpdate(t.a.doc)).toEqual(before);
    });
    test(`initially older layout remains unwritten layout=${layout} gc=${gc}`, async () => {
      const doc = createYDoc(null, {gc});
      doc.clientID = 80;
      const root = doc.get('lexical-y');
      doc.transact(() => {
        root.setAttr('lexical-y:' + layout, true);
        root.setAttr('lexical-y-schema:1', true);
        root.insert(0, 'abc');
        root.insert(3, [new Y.Node('¶')]);
      });
      const warnings: unknown[] = [];
      const editor = createEditor({
        namespace: 'test',
        nodes: NODES,
        onError: e => {
          throw e;
        },
        onWarn: e => warnings.push(e),
      });
      const b = new YBinding(editor, doc, {
        layoutUpgrade: null,
        schemaVersion: 1,
        selfCheck: true,
      });
      const before = Y.encodeStateAsUpdate(doc);
      b.start();
      b.initialize();
      editor.update(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('forbidden')),
          ),
        {discrete: true},
      );
      b.undo();
      b.redo();
      b.undoManager?.undo();
      b.undoManager?.redo();
      await flush();
      expect(b.status).toBe('readonly');
      expect(olderOf(warnings)).toEqual([[layout, 5]]);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      expect(() =>
        editYState(
          before,
          {nodes: NODES, schemaVersion: 1},
          () => $getRoot().append($p('forbidden')),
          {writer: null},
        ),
      ).toThrow();
      b.dispose();
      doc.destroy();
    });
  }
}

for (const gc of [false, true]) {
  test(`an edit inside an app transaction that removed the layout record is not written gc=${gc}`, async () => {
    const t = await setup(() => $getRoot().append($p('abc')), {gc});
    const root = t.a.doc.get('lexical-y');
    t.a.doc.transact(() => {
      root.deleteAttr('lexical-y:5');
      t.a.update(() => $getRoot().append($p('forbidden')));
    }, 'app');
    await flush();
    await t.sync();
    // The record is written again (a local transaction removed it, see
    // keepIdentityRecord); the edit made without it is not stored.
    expect(root.getAttr('lexical-y:5')).toBe(true);
    expect(JSON.stringify(root.toJSON())).not.toContain('forbidden');
    expect(t.b.describe()).not.toContain('forbidden');
  });
}
