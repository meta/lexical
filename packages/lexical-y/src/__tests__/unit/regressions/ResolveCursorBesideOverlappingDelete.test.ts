/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment jsdom

// $resolveCursor, called outside a Yjs transaction while a remote change is
// unread, after a local delete overlapping that change: Yjs merges the
// deleted items again once each transaction ends, and the view classifies an
// item by its first id, so the text only the unread change deleted (which
// the editor still shows) was taken for deleted, and a position past it
// resolved too early. It now resolves with the items split at the view's
// bounds, in a transaction that changes nothing, as getCursor takes
// positions. The change stays unread here while an app's mutation listener
// edits on the local update's commit (see
// ListenerEditBesideOverlappingDelete.test.ts).

import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {$selectIn, setup} from '../../utils/harness';

describe.each([false, true])(
  'a cursor resolved beside a local delete overlapping an unread one, gc %s',
  gc => {
    test('resolves where the editor shows it', async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('two three four')),
            $createParagraphNode().append($createTextNode('eight nine ten')),
          ),
        {gc, ids: [1, 2, 3]},
      );
      const {a, b} = t;
      const host = document.createElement('div');
      host.contentEditable = 'true';
      document.body.append(host);
      a.editor.setRootElement(host);
      let calls = 0;
      const seen: {
        editor: number | null;
        resolved: number | null;
      }[] = [];
      a.editor.registerMutationListener(
        TextNode,
        mutations => {
          if (calls < 3 && mutations.size > 0) {
            calls++;
            const cursor = a.binding.getCursor();
            seen.push(
              a.editor.getEditorState().read(() => {
                const selection = $getSelection();
                const points =
                  cursor === null ? null : a.binding.$resolveCursor(cursor);
                return {
                  editor: $isRangeSelection(selection)
                    ? selection.anchor.offset
                    : null,
                  resolved: points === null ? null : points.anchor.offset,
                };
              }),
            );
            a.editor.update(() => {
              const last = $getRoot().getLastChild();
              const text = $isElementNode(last)
                ? last.getLastDescendant()
                : null;
              if ($isTextNode(text)) {
                text.setTextContent(text.getTextContent() + '#');
              }
            });
          }
        },
        {skipInitialization: true},
      );
      try {
        t.offline();
        // B deletes "ne t"; A deletes "ine " and applies B's change inside
        // the same update: "t" is deleted by B only, which A still shows.
        b.update(() => {
          $selectIn([1], 8, 12).removeText();
        });
        const remote = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc));
        a.update(() => {
          $selectIn([1], 7, 11).removeText();
          Y.applyUpdate(a.doc, remote, 'provider');
          // "eight nte|n".
          $selectIn([1], 9);
        });
        await Promise.resolve();
        await t.sync();
        // The first call runs on the local update's commit before the
        // binding writes it (Lexical notifies mutation listeners first): its
        // cursor is of content not stored yet. The others run after A's
        // write merged the deleted items, with the change still unread.
        const after = seen.slice(1);
        expect(after.length).toBe(2);
        expect(after.map(s => [s.editor, s.resolved])).toEqual([
          [9, 9],
          [9, 9],
        ]);
      } finally {
        host.remove();
      }
    });

    test('resolves from a transaction observer without opening transactions without end', async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('two three four')),
            $createParagraphNode().append($createTextNode('eight nine ten')),
          ),
        {gc, ids: [1, 2, 3]},
      );
      const {a, b} = t;
      const host = document.createElement('div');
      host.contentEditable = 'true';
      document.body.append(host);
      a.editor.setRootElement(host);
      let edits = 0;
      a.editor.registerMutationListener(
        TextNode,
        mutations => {
          if (edits < 3 && mutations.size > 0) {
            edits++;
            a.editor.update(() => {
              const last = $getRoot().getLastChild();
              const text = $isElementNode(last)
                ? last.getLastDescendant()
                : null;
              if ($isTextNode(text)) {
                text.setTextContent(text.getTextContent() + '#');
              }
            });
          }
        },
        {skipInitialization: true},
      );
      // An app resolving its cursor on every transaction (an awareness
      // cursor): the transaction $resolveCursor may open calls it again.
      let calls = 0;
      const seen: [string, number | null, number | null][] = [];
      // From A's first write on: before it, the editor shows a commit the
      // binding has not written yet (Lexical notifies its listeners first),
      // and a cursor taken there is of content not stored yet.
      let written = false;
      const observe = (tr: Y.Transaction) => {
        calls++;
        if (tr.origin === a.binding) {
          written = true;
        }
        if (calls > 50 || !written) {
          return;
        }
        const cursor = a.binding.getCursor();
        seen.push(
          a.editor.getEditorState().read(() => {
            const selection = $getSelection();
            const points =
              cursor === null ? null : a.binding.$resolveCursor(cursor);
            return [
              $getRoot().getTextContent(),
              $isRangeSelection(selection) ? selection.anchor.offset : null,
              points === null ? null : points.anchor.offset,
            ];
          }),
        );
      };
      try {
        t.offline();
        b.update(() => {
          $selectIn([1], 8, 12).removeText();
        });
        const remote = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc));
        a.doc.on('afterTransaction', observe);
        a.doc.on('afterTransactionCleanup', observe);
        a.update(() => {
          $selectIn([1], 7, 11).removeText();
          Y.applyUpdate(a.doc, remote, 'provider');
          $selectIn([1], 9);
        });
        await Promise.resolve();
        await t.sync();
        a.doc.off('afterTransaction', observe);
        a.doc.off('afterTransactionCleanup', observe);
        expect(calls).toBeLessThan(50);
        // Where the editor shows A's delete, written, and the change is
        // unread, the cursor resolves where the editor shows it.
        const shown = seen.filter(([text]) => text.includes('eight nte'));
        expect(shown.length).toBeGreaterThan(0);
        expect(shown.map(([, editor, at]) => [editor, at])).toEqual(
          shown.map(([, editor]) => [editor, editor]),
        );
      } finally {
        a.doc.off('afterTransaction', observe);
        a.doc.off('afterTransactionCleanup', observe);
        host.remove();
      }
    });
  },
);
