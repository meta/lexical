/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Paired items that reach a client before the layout 3 record (an agent's
// later edit, made from a stale state with the same writer, arrives first:
// its update skips the clocks of the edit that wrote the record) are read
// as plain values until the record arrives; then every container is read
// again, a table cell's line included. Before: only the root's lines were,
// and a comment's end stayed on the text after the comment as the NodeState
// {"markIds\u001fa2": [1]}.
// Where that text is in another comment its signature does not change when
// it is read again, so the stray entry itself makes it built again.

import {buildEditorFromExtensions} from '@lexical/extension';
import {$addMarkID, MarkStateExtension} from '@lexical/mark';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  TableExtension,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isTextNode,
  defineExtension,
} from 'lexical';
import {afterEach, expect, test} from 'vitest';

import {createYCollabConfig, createYDoc} from '../../..';
import {createYWriter, editYState, seedYState} from '../../../headless';
import {flush} from '../../utils/harness';
import {setFormatIdentityWritesDefault} from '../../utils/noSwitch';

const EXTENSIONS = [RichTextExtension, TableExtension, MarkStateExtension];
const CONFIG = {extensions: EXTENSIONS, schemaVersion: 1};

afterEach(() => {
  setFormatIdentityWritesDefault(false);
});

/** Comment `id` on `token` in the text node that holds it. */
function $markToken(token: string, id: string): void {
  for (const node of $getRoot().getAllTextNodes()) {
    const at = node.getTextContent().indexOf(token);
    if (at >= 0) {
      const sel = $createRangeSelection();
      sel.anchor.set(node.getKey(), at, 'text');
      sel.focus.set(node.getKey(), at + token.length, 'text');
      $addMarkID(id, sel);
      return;
    }
  }
  throw new Error(`no ${token}`);
}

/** Select `token` in the text node that holds it. */
function $selectToken(token: string): void {
  for (const node of $getRoot().getAllTextNodes()) {
    const at = node.getTextContent().indexOf(token);
    if ($isTextNode(node) && at >= 0) {
      const sel = $createRangeSelection();
      sel.anchor.set(node.getKey(), at, 'text');
      sel.focus.set(node.getKey(), at + token.length, 'text');
      $addMarkID(token === 't23z' ? 'a1' : 'a2', sel);
      return;
    }
  }
  throw new Error(`no ${token}`);
}

function bound(
  state: Uint8Array,
  gc: boolean,
): [ReturnType<typeof buildEditorFromExtensions>, Y.Doc] {
  const doc = createYDoc(state, {gc});
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        ...EXTENSIONS,
        createYCollabConfig({
          doc,
          layoutUpgrade: null,
          schemaVersion: 1,
          synced: true,
        }),
      ],
      name: 'reader',
      onError: e => {
        throw e;
      },
    }),
  );
  return [editor, doc];
}

for (const gc of [false, true]) {
  for (const [lateRecord, covered] of [
    [false, false],
    [true, false],
    [true, true],
  ]) {
    test(`a comment's end in a table cell reads as an end once the record arrives (${lateRecord ? 'record after the items' : 'causal'}${covered ? ', the text after it in another comment' : ''}, gc ${gc ? 'on' : 'off'})`, async () => {
      setFormatIdentityWritesDefault(true);
      const seeded = seedYState(CONFIG, () => {
        const $cell = (text: string) =>
          $createTableCellNode().append(
            $createParagraphNode().append($createTextNode(text)),
          );
        $getRoot().append(
          $createParagraphNode().append($createTextNode('t1z')),
          $createTableNode().append(
            $createTableRowNode().append(
              $cell('t23z t24z'),
              $cell('t25z t26z'),
            ),
          ),
        );
        if (covered) {
          // Another comment on the text right after the agent's: the stray
          // value then sits on a node whose signature (its comments) does
          // not change when it is read again.
          $markToken(' t26z', 'a9');
        }
      });
      const writer = createYWriter('agent');
      // The first edit writes the layout 3 record; the second, with the
      // same writer, is made from the state with the first. A client that
      // gets the second first integrates it after a skip over the first's
      // clocks.
      const first = editYState(seeded, CONFIG, () => $selectToken('t23z'), {
        writer,
      }).update!;
      const second = editYState(
        Y.mergeUpdates([new Uint8Array(seeded), new Uint8Array(first)]),
        CONFIG,
        () => $selectToken('t25z'),
        {writer},
      ).update!;
      const [editor, doc] = bound(seeded, gc);
      await flush();
      for (const update of lateRecord ? [second, first] : [first, second]) {
        Y.applyUpdate(doc, update);
        await flush();
      }
      const [fresh] = bound(Y.encodeStateAsUpdate(doc), gc);
      await flush();
      expect(JSON.stringify(editor.getEditorState().toJSON())).toBe(
        JSON.stringify(fresh.getEditorState().toJSON()),
      );
      expect(JSON.stringify(editor.getEditorState().toJSON())).not.toContain(
        'markIds\\u001fa2',
      );
      editor.dispose();
      fresh.dispose();
    });
  }
}
