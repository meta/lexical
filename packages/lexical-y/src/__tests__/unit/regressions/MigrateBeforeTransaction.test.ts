/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Writes are admitted inside their own transaction (code review round 1,
// M4): an app's beforeTransaction listener runs at the start of the
// binding's write transaction, and of an undo's, and may change the layout
// record there. The editor's write and every undo or redo (the binding's,
// and its exposed UndoManager's) then write nothing, and the binding reads
// the record (read only). Main had the same gap for the editor's write.

import type * as Y from '@y/y';

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';

import {createYDoc, LAYOUT_VERSION, YBinding} from '../../..';
import {setMinLayoutForTests} from '../../../internal/Binding';
import {catalogAppExtension} from '../../catalog/bind';
import {admitted, FLOOR, rawDoc} from '../../utils/migrateSteps';
import {textOf} from '../../utils/splitFixtures';

afterEach(() => setMinLayoutForTests(null));

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function bind(gc: boolean) {
  setMinLayoutForTests(FLOOR);
  const doc = createYDoc(rawDoc(FLOOR), {gc});
  const errors: Error[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [catalogAppExtension({blockIds: 'absent'})],
      name: 'before-transaction',
      onError: e => {
        errors.push(e);
      },
      onWarn: () => {},
    }),
  );
  const binding = new YBinding(editor, doc, {
    captureTimeout: 0,
    schemaVersion: 1,
  });
  binding.start();
  binding.initialize();
  const dispose = () => {
    binding.dispose();
    editor.dispose();
    doc.destroy();
  };
  return {binding, dispose, doc, editor, errors};
}

function append(editor: LexicalEditor, s: string): void {
  editor.update(
    () => {
      $getRoot().append($createParagraphNode().append($createTextNode(s)));
    },
    {discrete: true},
  );
}

const text = (doc: Y.Doc) => textOf(doc.get('lexical-y'));

/** On the next transaction only, make the root's record `cause`. */
function spoilOnNextTransaction(doc: Y.Doc, cause: 'newer' | 'older'): void {
  let done = false;
  doc.on('beforeTransaction', () => {
    if (done) {
      return;
    }
    done = true;
    const root = doc.get('lexical-y');
    if (cause === 'newer') {
      root.setAttr(`lexical-y:${LAYOUT_VERSION + 1}`, true);
    } else {
      root.setAttr(`lexical-y:${FLOOR - 1}`, true);
      root.deleteAttr(`lexical-y:${FLOOR}`);
    }
  });
}

describe.each([false, true])('admission after beforeTransaction, gc %s', gc => {
  for (const cause of ['newer', 'older'] as const) {
    for (const method of [
      'editor',
      'binding undo',
      'binding redo',
      'manager undo',
      'manager redo',
    ] as const) {
      test(`a listener making the record ${cause}: ${method} writes nothing`, async () => {
        const t = bind(gc);
        append(t.editor, 'local');
        await flush();
        if (method.endsWith('redo')) {
          expect(t.binding.undo()).toBe(true);
          await flush();
        }
        const before = text(t.doc);
        spoilOnNextTransaction(t.doc, cause);
        let result: unknown = 'none';
        if (method === 'editor') {
          append(t.editor, 'forbidden');
        } else if (method === 'binding undo') {
          result = t.binding.undo();
        } else if (method === 'binding redo') {
          result = t.binding.redo();
        } else if (method === 'manager undo') {
          result = t.binding.undoManager!.undo();
        } else {
          result = t.binding.undoManager!.redo();
        }
        await flush();
        // A build that puts a removed seed record back itself may have done
        // so before the write (it is then admitted): only a record that
        // still does not admit writes proves the write was refused.
        if (!admitted(t.doc.get('lexical-y'))) {
          expect(text(t.doc)).toBe(before);
          if (method !== 'editor') {
            expect(result === false || result === null).toBe(true);
          }
          expect(t.binding.status).toBe('readonly');
        } else {
          expect(cause).toBe('older');
          expect(t.binding.status).toBe('active');
        }
        expect(t.errors).toEqual([]);
        t.dispose();
      });
    }
  }

  test('an undo and a redo through the exposed UndoManager still round-trip, each on its own stack', async () => {
    const t = bind(gc);
    const start = text(t.doc);
    append(t.editor, 'one');
    await flush();
    const um = t.binding.undoManager!;
    expect(um.undo()).not.toBeNull();
    expect(text(t.doc)).toBe(start);
    expect(um.undoStack.length).toBe(0);
    expect(um.redoStack.length).toBe(1);
    expect(um.redo()).not.toBeNull();
    expect(text(t.doc)).toBe(start + 'one');
    expect(um.undoStack.length).toBe(1);
    expect(um.redoStack.length).toBe(0);
    t.dispose();
  });

  test('control: initialization and an edit inside one app transaction are stored, active', () => {
    const doc = createYDoc(null, {gc});
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [catalogAppExtension({blockIds: 'absent'})],
        name: 'init-in-app-transaction',
        onError: e => {
          throw e;
        },
        onWarn: () => {},
      }),
    );
    const binding = new YBinding(editor, doc, {schemaVersion: 1});
    binding.start();
    doc.transact(() => {
      append(editor, 'seed');
      binding.initialize();
      append(editor, 'inside');
    }, 'app');
    expect(text(doc)).toContain('seed');
    expect(text(doc)).toContain('inside');
    expect(binding.status).toBe('active');
    binding.dispose();
    editor.dispose();
    doc.destroy();
  });
});

// A binding undo or redo starts with a scan; an app's beforeTransaction
// listener that changes records inside it must be noticed whatever order it
// writes them in: a gate key that still admits (the recorded layout again)
// does not hide a schema record that refuses (code review round 4).
describe.each([false, true])(
  "records changed inside a binding undo's scan, gc %s",
  gc => {
    for (const order of ['layout first', 'schema first'] as const) {
      for (const method of ['binding undo', 'binding redo'] as const) {
        test(`${method}, ${order}: refused, read only, not editable`, async () => {
          const t = bind(gc);
          append(t.editor, 'local');
          await flush();
          if (method === 'binding redo') {
            expect(t.binding.undo()).toBe(true);
            await flush();
          }
          const before = text(t.doc);
          let done = false;
          t.doc.on('beforeTransaction', () => {
            if (done) {
              return;
            }
            done = true;
            const root = t.doc.get('lexical-y');
            const layout = () => root.setAttr(`lexical-y:${FLOOR}`, true);
            const schema = () => root.setAttr('lexical-y-schema:2', true);
            if (order === 'layout first') {
              layout();
              schema();
            } else {
              schema();
              layout();
            }
          });
          const result =
            method === 'binding undo' ? t.binding.undo() : t.binding.redo();
          await flush();
          expect(text(t.doc)).toBe(before);
          expect(result === false || result === null).toBe(true);
          expect(t.binding.status).toBe('readonly');
          expect(t.editor.isEditable()).toBe(false);
          t.dispose();
        });
      }
    }
  },
);
