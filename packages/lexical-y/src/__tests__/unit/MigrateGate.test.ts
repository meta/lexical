/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The 'older' gate against records that go away (ported from the identity
// project's review round 9; the floor is FLOOR, raised with the internal
// override where MIN_LAYOUT is 1): an app UndoManager that undoes only the
// newest layout record a seed wrote inside an app transaction, and a
// remote update that removes it, never leave a writable binding below the
// floor (or without a record); the 'older' warning comes once per
// read-only period. The seed holds a MarkState comment, so on a build whose seed
// records layout 1 it records layout 2 too.

import {buildEditorFromExtensions} from '@lexical/extension';
import {$addMarkID} from '@lexical/mark';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';

import {createYDoc, YBinding, type YBindingOptions, type YDoc} from '../..';
import {setMinLayoutForTests} from '../../internal/Binding';
import {recordedLayout} from '../../internal/Runner';
import {catalogAppExtension} from '../catalog/bind';
import {FLOOR, rawDoc} from '../utils/migrateSteps';

const CFG = {blockIds: 'absent', marks: 'mark-state'} as const;
const ROOT = 'lexical-y';

function editorOf(warnings: string[] = []): LexicalEditor {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [catalogAppExtension(CFG)],
      name: 'migrate-gate',
      onError: e => {
        throw e;
      },
      onWarn: w => {
        warnings.push(String((w as {data?: {reason?: string}}).data?.reason));
      },
    }),
  );
}

function bindTo(
  doc: YDoc,
  options: Partial<YBindingOptions> = {},
): {editor: LexicalEditor; binding: YBinding; warnings: string[]} {
  const warnings: string[] = [];
  const editor = editorOf(warnings);
  const binding = new YBinding(editor, doc, {schemaVersion: 1, ...options});
  binding.start();
  binding.initialize();
  return {binding, editor, warnings};
}

/** A comment on the editor's first text: a member entry (layout 2). */
function $commented(): void {
  const text = $createTextNode('abcd');
  $getRoot().clear().append($createParagraphNode().append(text));
  const s = $createRangeSelection();
  s.anchor.set(text.getKey(), 1, 'text');
  s.focus.set(text.getKey(), 3, 'text');
  $addMarkID('c1', s);
}

/** Try a local write; whether the document changed. */
function writes(editor: LexicalEditor, doc: Y.Doc): boolean {
  const before = Y.encodeStateAsUpdate(doc);
  editor.update(
    () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('forbidden')),
      );
    },
    {discrete: true},
  );
  return !Buffer.from(before).equals(Buffer.from(Y.encodeStateAsUpdate(doc)));
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

afterEach(() => {
  setMinLayoutForTests(null);
});

describe.each([false, true])('the older gate, gc %s', gc => {
  test('a seed written inside an app transaction, then an app undo of only its layout record: the record is written again untracked, so the undo changes nothing and both stay writable', async () => {
    setMinLayoutForTests(FLOOR);
    const doc = createYDoc(null, {gc});
    doc.clientID = 7;
    const editor = editorOf();
    editor.update($commented, {discrete: true});
    const b = new YBinding(editor, doc, {schemaVersion: 1});
    b.start();
    const app = new Y.UndoManager(doc, {
      captureTimeout: 0,
      deleteFilter: item => item.parentSub === `lexical-y:${FLOOR}`,
      trackedOrigins: new Set(['outer']),
    });
    doc.transact(() => b.initialize(), 'outer');
    await flush();
    expect(recordedLayout(doc)).toBe(FLOOR);
    expect(b.status).toBe('active');
    const base = Y.encodeStateAsUpdate(doc);
    // A receiver bound at the floor, before the undo.
    const receiver = createYDoc(base, {gc});
    const r = bindTo(receiver);
    expect(r.binding.status).toBe('active');
    const updates: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => updates.push(u));
    app.undo();
    await flush();
    // The seed's record is written again after the outer transaction, in a
    // transaction no UndoManager tracks (Ident.protectRecordAfter): the undo
    // deletes only the item that write overwrote, so it changes nothing,
    // sends nothing, and both bindings stay writable at the floor.
    expect(updates).toEqual([]);
    expect(recordedLayout(doc)).toBe(FLOOR);
    expect(b.status).toBe('active');
    expect(r.binding.status).toBe('active');
    expect(writes(editor, doc)).toBe(true);
    // The receiver gets the write and stays at the floor.
    for (const u of updates.splice(0)) {
      Y.applyUpdate(receiver, u, 'remote');
    }
    await flush();
    expect(recordedLayout(receiver)).toBe(FLOOR);
    expect(r.binding.status).toBe('active');
    app.destroy();
    b.dispose();
    r.binding.dispose();
  });

  test('a remote update that removes the record below the floor turns an active binding read only (M2)', async () => {
    // Seeded at the build's own floor, then the floor set to FLOOR (the
    // seed with its comment records it).
    const doc = createYDoc(null, {gc});
    const seeder = bindTo(doc);
    seeder.editor.update($commented, {discrete: true});
    await flush();
    expect(recordedLayout(doc)).toBe(FLOOR);
    setMinLayoutForTests(FLOOR);
    const local = createYDoc(Y.encodeStateAsUpdate(doc), {gc});
    const b = bindTo(local);
    expect(b.binding.status).toBe('active');
    expect(writes(b.editor, local)).toBe(true);
    const remote = createYDoc(Y.encodeStateAsUpdate(local), {gc});
    remote.clientID = 80;
    const sv = Y.encodeStateVector(remote);
    // (A new document records its own layout only, so the record below
    // the floor is written here: an older release's.)
    remote.transact(() => {
      remote.get(ROOT).deleteAttr(`lexical-y:${FLOOR}`);
      remote.get(ROOT).setAttr(`lexical-y:${FLOOR - 1}`, true);
    });
    Y.applyUpdate(local, Y.encodeStateAsUpdate(remote, sv), 'remote');
    await flush();
    const dropped = recordedLayout(local);
    expect(dropped === null || dropped < FLOOR).toBe(true);
    expect(b.binding.status).toBe('readonly');
    expect(
      b.warnings.some(w => w === (dropped === null ? 'removed' : 'older')),
    ).toBe(true);
    expect(writes(b.editor, local)).toBe(false);
    seeder.binding.dispose();
    b.binding.dispose();
  });

  test("the 'older' warning comes once per read-only period (S1)", async () => {
    setMinLayoutForTests(FLOOR);
    const doc = createYDoc(rawDoc(FLOOR - 1), {gc});
    doc.clientID = 7;
    const b = bindTo(doc, {});
    await flush();
    const incoming = (fn: (root: Y.Node) => void) => {
      const r = createYDoc(Y.encodeStateAsUpdate(doc), {gc});
      const sv = Y.encodeStateVector(r);
      r.transact(() => fn(r.get(ROOT)));
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(r, sv), 'remote');
      r.destroy();
    };
    expect(b.binding.status).toBe('readonly');
    incoming(r => r.setAttr(`lexical-y:${FLOOR}`, true));
    expect(b.binding.status).toBe('active');
    incoming(r => r.setAttr('lexical-y:999', true));
    expect(b.binding.status).toBe('readonly');
    incoming(r => {
      r.deleteAttr('lexical-y:999');
      r.deleteAttr(`lexical-y:${FLOOR}`);
    });
    await flush();
    expect(b.binding.status).toBe('readonly');
    expect(b.warnings.filter(w => w === 'older')).toHaveLength(2);
    b.binding.dispose();
  });
});
