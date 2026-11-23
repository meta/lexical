/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Live list items carry `value` only where the browser's own count would draw
// another number (see `$updateListItemValueDOM`). An item's decision depends
// on the item before it, so these tests compare the number a browser draws
// for every item (its `value`, else the list's `start` or the previous item's
// number plus one) with the item's own `getValue()`, after each kind of edit
// and after undoing and redoing it.

import {createEmptyHistoryState, registerHistory} from '@lexical/history';
import {ListItemNode, ListNode} from '@lexical/list';
import {
  $getRoot,
  createEditor,
  HISTORY_PUSH_TAG,
  type LexicalEditor,
  ParagraphNode,
  REDO_COMMAND,
  TextNode,
  UNDO_COMMAND,
} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';

import {drawnAndModel, LIST_EDIT_CASES} from './listEditCases';

describe('a numbered list draws every item’s own number', () => {
  let editor: LexicalEditor;
  afterEach(() => {
    editor.setRootElement(null);
  });

  test.each(LIST_EDIT_CASES.map(c => [c.name, c] as const))(
    '%s, then undo and redo',
    (_name, c) => {
      editor = createEditor({
        nodes: [ListNode, ListItemNode, ParagraphNode, TextNode],
        onError: e => {
          throw e;
        },
      });
      const root = document.createElement('div');
      editor.setRootElement(root);
      registerHistory(editor, createEmptyHistoryState(), 0);
      editor.update(() => $getRoot().append(...c.$build()), {discrete: true});
      const built = drawnAndModel(editor);
      expect(built.drawn).toEqual(built.model);
      if (c.built !== undefined) {
        expect(built.model, 'as built').toEqual(c.built);
      }

      editor.update(c.$edit, {discrete: true, tag: HISTORY_PUSH_TAG});
      const edited = drawnAndModel(editor);
      expect(edited.drawn, 'after the edit').toEqual(edited.model);

      editor.dispatchCommand(UNDO_COMMAND, undefined);
      const undone = drawnAndModel(editor);
      expect(undone.drawn, 'after undo').toEqual(undone.model);
      expect(undone.model, 'undo restores the numbers').toEqual(built.model);

      editor.dispatchCommand(REDO_COMMAND, undefined);
      const redone = drawnAndModel(editor);
      expect(redone.drawn, 'after redo').toEqual(redone.model);
      expect(redone.model, 'redo restores the numbers').toEqual(edited.model);
    },
  );
});
