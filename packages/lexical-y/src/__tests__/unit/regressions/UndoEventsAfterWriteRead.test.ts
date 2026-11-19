/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The binding writes a local commit inside a read of its state with the
// editor active (#9934). Yjs's callbacks as the write's transactions end
// (the undo manager's stack-item-added and stack-cleared, a document's
// afterTransaction handlers) run as they did before: in a read of that state
// with no active editor, so the extension's CAN_UNDO_COMMAND and
// CAN_REDO_COMMAND dispatches, or an app's, are not updates started in a
// read-only context, which log a development warning.

import type {LexicalEditor} from 'lexical';

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  createCommand,
  defineExtension,
  REDO_COMMAND,
  UNDO_COMMAND,
} from 'lexical';
import {assert, expect, onTestFinished, test, vi} from 'vitest';

import {createYCollabConfig, createYDoc, YCollabExtension} from '../../..';

function setUp() {
  const can: {redo: boolean[]; undo: boolean[]} = {redo: [], undo: []};
  const doc = createYDoc();
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        createYCollabConfig({
          doc,
          layoutUpgrade: null,
          onYStatus: null,
          schemaVersion: 1,
          synced: true,
        }),
      ],
      name: '@lexical/y/test/undo-events',
      onError: e => {
        throw e;
      },
      register: ed => {
        const unregisterUndo = ed.registerCommand(
          CAN_UNDO_COMMAND,
          value => {
            can.undo.push(value);
            return false;
          },
          COMMAND_PRIORITY_CRITICAL,
        );
        const unregisterRedo = ed.registerCommand(
          CAN_REDO_COMMAND,
          value => {
            can.redo.push(value);
            return false;
          },
          COMMAND_PRIORITY_CRITICAL,
        );
        return () => {
          unregisterUndo();
          unregisterRedo();
        };
      },
    }),
  );
  onTestFinished(() => editor.dispose());
  const um = getExtensionDependencyFromEditor(editor, YCollabExtension).output
    .binding.undoManager;
  assert(um !== null, 'undo manager');
  const warn = vi.spyOn(console, 'warn');
  onTestFinished(() => warn.mockRestore());
  return {can, doc, editor, um, warn};
}

function append(editor: LexicalEditor, text: string): void {
  editor.update(
    () => {
      $getRoot().append($createParagraphNode().append($createTextNode(text)));
    },
    {discrete: true},
  );
}

function texts(editor: LexicalEditor): string[] {
  return editor.read(() =>
    $getRoot()
      .getChildren()
      .map(node => node.getTextContent()),
  );
}

test('a local edit announces its undo step without the active editor', () => {
  const {can, editor, um, warn} = setUp();
  const seen: string[] = [];
  um.on('stack-item-added', () => {
    // In the written state, as before.
    seen.push($getRoot().getTextContent());
  });
  for (const text of ['a', 'b']) {
    um.stopCapturing();
    append(editor, text);
  }
  expect(seen).toEqual(['\n\na', '\n\na\n\nb']);
  expect(can.undo[can.undo.length - 1]).toBe(true);
  expect(warn).not.toHaveBeenCalled();
});

test('an edit that clears the redo stack announces it without the active editor', () => {
  const {can, editor, um, warn} = setUp();
  append(editor, 'a');
  um.stopCapturing();
  append(editor, 'b');
  editor.dispatchCommand(UNDO_COMMAND, undefined);
  expect(can.redo[can.redo.length - 1]).toBe(true);
  um.stopCapturing();
  append(editor, 'c');
  expect(can.redo[can.redo.length - 1]).toBe(false);
  expect(can.undo[can.undo.length - 1]).toBe(true);
  expect(texts(editor)).toEqual(['', 'a', 'c']);
  editor.dispatchCommand(UNDO_COMMAND, undefined);
  editor.dispatchCommand(REDO_COMMAND, undefined);
  expect(texts(editor)).toEqual(['', 'a', 'c']);
  expect(warn).not.toHaveBeenCalled();
});

test("an app's afterTransaction handler can dispatch a command during a local write", () => {
  const {doc, editor, warn} = setUp();
  const APP_COMMAND = createCommand<void>('APP_COMMAND');
  let handled = 0;
  onTestFinished(
    editor.registerCommand(
      APP_COMMAND,
      () => {
        handled++;
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    ),
  );
  doc.on('afterTransaction', () =>
    editor.dispatchCommand(APP_COMMAND, undefined),
  );
  append(editor, 'a');
  expect(handled).toBeGreaterThan(0);
  expect(warn).not.toHaveBeenCalled();
});
