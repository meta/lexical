/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The binding's UndoManager emits its events as Yjs's does (code review
// round 2, M5): `stack-item-popped` after the step's transaction has ended
// and its capture ran, so a listener sees the step on the other stack, no
// open transaction, and can run a migration. Compared with a plain Yjs
// UndoManager running the same steps, and with what main recorded.

import {buildEditorFromExtensions} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YBinding} from '../../..';
import {migrateYDoc} from '../../../migrate';
import {catalogAppExtension} from '../../catalog/bind';
import {rawDoc, SEED, stamp} from '../../utils/migrateSteps';
import {textOf} from '../../utils/splitFixtures';

function append(editor: LexicalEditor, s: string): void {
  editor.update(
    () => {
      $getRoot().append($createParagraphNode().append($createTextNode(s)));
    },
    {discrete: true},
  );
}

function bound(gc: boolean) {
  const doc = createYDoc(rawDoc(SEED), {gc});
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [catalogAppExtension({blockIds: 'absent'})],
      name: 'undo-events',
      onError: e => {
        throw e;
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
  append(editor, 'local');
  const dispose = () => {
    binding.dispose();
    editor.dispose();
    doc.destroy();
  };
  return {binding, dispose, doc, editor, um: binding.undoManager!};
}

/** A plain Yjs UndoManager on its own document, one step recorded. */
function plain(gc: boolean) {
  const doc = createYDoc(rawDoc(SEED), {gc});
  const um = new Y.UndoManager(doc.get('lexical-y'), {captureTimeout: 0});
  doc.transact(() => doc.get('lexical-y').insert(3, 'local'), null);
  return {doc, um};
}

type Event = {
  event: string;
  type: string;
  canUndo: boolean;
  canRedo: boolean;
  inTransaction: boolean;
  changed: number;
};

function record(um: Y.UndoManager, doc: Y.Doc): Event[] {
  const events: Event[] = [];
  const note =
    (event: string) =>
    (e: {type: string; changedParentTypes: Map<unknown, unknown>}) =>
      events.push({
        canRedo: um.canRedo(),
        canUndo: um.canUndo(),
        changed: e.changedParentTypes.size,
        event,
        inTransaction: doc._transaction !== null,
        type: e.type,
      });
  um.on('stack-item-added', note('added') as never);
  um.on('stack-item-popped', note('popped') as never);
  return events;
}

describe.each([false, true])('undo manager events, gc %s', gc => {
  for (const step of ['undo', 'redo'] as const) {
    test(`${step}: the order, the stacks and the transaction state listeners see are Yjs's`, () => {
      const p = plain(gc);
      const b = bound(gc);
      if (step === 'redo') {
        p.um.undo();
        b.um.undo();
      }
      const ref = record(p.um, p.doc);
      const got = record(b.um, b.doc);
      p.um[step]();
      b.um[step]();
      expect(got.map(({changed: _c, ...e}) => e)).toEqual(
        ref.map(({changed: _c, ...e}) => e),
      );
      // The pop event carries the types the step changed.
      expect(got.find(e => e.event === 'popped')!.changed).toBeGreaterThan(0);
      if (step === 'undo') {
        // Main: added(redo, canRedo=true), popped(undo, canRedo=true).
        expect(got.map(e => [e.event, e.type, e.canRedo])).toEqual([
          ['added', 'redo', true],
          ['popped', 'undo', true],
        ]);
      }
      p.doc.destroy();
      b.dispose();
    });
  }

  test('a listener of the pop runs a migration on the document (no open transaction)', () => {
    const b = bound(gc);
    let changed: boolean | null = null;
    let code: string | null = null;
    b.um.on('stack-item-popped', () => {
      try {
        changed = migrateYDoc(b.doc, [stamp(SEED)], {to: SEED + 1}).changed;
      } catch (e) {
        code = (e as {code: string}).code;
      }
    });
    b.um.undo();
    expect(code).toBeNull();
    expect(changed).toBe(true);
    b.dispose();
  });

  test('the editor shows the undone step when the pop listener runs', () => {
    const b = bound(gc);
    let seen = '';
    b.um.on('stack-item-popped', () => {
      seen = textOf(b.doc.get('lexical-y'));
    });
    b.binding.undo();
    expect(seen).not.toContain('local');
    b.dispose();
  });

  test('a listener that throws: the error reaches the caller and both stacks are as recorded', () => {
    const b = bound(gc);
    append(b.editor, 'more');
    b.um.stopCapturing();
    b.um.undo();
    b.um.on('stack-item-popped', () => {
      throw new Error('listener');
    });
    expect(() => b.um.undo()).toThrow('listener');
    expect([b.um.undoStack.length, b.um.redoStack.length]).toEqual([0, 2]);
    b.dispose();
  });
});
