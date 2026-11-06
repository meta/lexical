/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Raw Yjs writes are unsupported: the Yjs content under the binding's root
// is private to it. In development builds the binding reports a local
// transaction of another origin that changes it (RAW_YJS_WRITE_WARNING),
// once per binding and origin, with what it changed first and the origin's
// constructor name. Its own writes, Y.UndoManager steps and remote updates
// are not reported.

import {buildEditorFromExtensions} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, RAW_YJS_WRITE_WARNING, YBinding} from '../../..';
import {catalogAppExtension} from '../../catalog/bind';
import {rawDoc, SEED} from '../../utils/migrateSteps';

const CFG = {blockIds: 'absent'} as const;
type Warning = {code?: string; data?: Record<string, unknown>};

class AppOrigin {}

function bind(gc: boolean) {
  const doc = createYDoc(rawDoc(SEED), {gc});
  const warnings: Warning[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [catalogAppExtension(CFG)],
      name: 'raw-writes',
      onWarn: w => {
        warnings.push(w as Warning);
      },
    }),
  );
  const binding = new YBinding(editor, doc, {schemaVersion: 1});
  binding.start();
  binding.initialize();
  const raw = () =>
    warnings.filter(w => w.code === RAW_YJS_WRITE_WARNING).map(w => w.data);
  const dispose = () => {
    binding.dispose();
    editor.dispose();
    doc.destroy();
  };
  return {binding, dispose, doc, editor, raw, root: doc.get('lexical-y')};
}

describe.each([false, true])('raw Yjs writes, gc %s', gc => {
  test('a raw format, a raw insert and a raw attribute are reported once per origin, with what they changed', () => {
    const t = bind(gc);
    expect(t.binding.status).toBe('active');
    const app = new AppOrigin();
    t.doc.transact(() => {
      t.root.format(0, 1, {'f:raw': true});
    }, app);
    expect(t.raw()).toEqual([
      {
        key: 'f:raw',
        kind: 'format',
        origin: 'AppOrigin',
        reason: 'raw-write',
        root: 'lexical-y',
      },
    ]);
    // The same origin again: not again.
    t.doc.transact(() => {
      t.root.insert(0, 'x');
    }, app);
    expect(t.raw()).toHaveLength(1);
    // Another origin: a raw insert (no origin at all).
    t.doc.transact(() => {
      t.root.insert(0, 'y');
    });
    // A third: a raw attribute.
    t.doc.transact(() => {
      t.root.setAttr('lexical-y-acme', 1);
    }, 'tool');
    expect(t.raw().slice(1)).toEqual([
      {
        key: null,
        kind: 'content',
        origin: 'null',
        reason: 'raw-write',
        root: 'lexical-y',
      },
      {
        key: 'lexical-y-acme',
        kind: 'attribute',
        origin: 'string',
        reason: 'raw-write',
        root: 'lexical-y',
      },
    ]);
    t.dispose();
  });

  test("an app UndoManager's step, a remote update and the binding's own writes are not reported", () => {
    const t = bind(gc);
    const app = new AppOrigin();
    const um = new Y.UndoManager(t.root, {
      captureTimeout: 0,
      trackedOrigins: new Set([app]),
    });
    t.doc.transact(() => {
      t.root.insert(0, 'z');
    }, app);
    expect(t.raw()).toHaveLength(1);
    // Undo and redo run with the UndoManager as their origin.
    um.undo();
    um.redo();
    // A remote update: not local.
    const other = createYDoc(Y.encodeStateAsUpdate(t.doc), {gc});
    const sv = Y.encodeStateVector(other);
    other.get('lexical-y').insert(0, 'remote');
    Y.applyUpdate(t.doc, Y.encodeStateAsUpdate(other, sv), 'provider');
    // The binding's own write.
    t.editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('edit')),
        );
      },
      {discrete: true},
    );
    expect(t.raw()).toHaveLength(1);
    um.destroy();
    other.destroy();
    t.dispose();
  });

  test('another binding of the same root writes with its own origins: not reported', () => {
    const t = bind(gc);
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [catalogAppExtension(CFG)],
        name: 'raw-writes-other',
      }),
    );
    const other = new YBinding(editor, t.doc, {schemaVersion: 1});
    other.start();
    other.initialize();
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('other')),
        );
      },
      {discrete: true},
    );
    expect(t.raw()).toEqual([]);
    other.dispose();
    editor.dispose();
    t.dispose();
  });

  test('a write outside the root is not reported', () => {
    const t = bind(gc);
    t.doc.transact(() => {
      t.doc.get('app-data').setAttr('k', 1);
    }, new AppOrigin());
    expect(t.raw()).toEqual([]);
    t.dispose();
  });
});
