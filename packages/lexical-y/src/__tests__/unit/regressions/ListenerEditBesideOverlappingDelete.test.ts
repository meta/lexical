/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment jsdom

// An app's mutation listener that edits the document (appends '#' to the
// last line, at most three times), in an editor with a DOM root, while a
// provider applies a remote change inside a local update that deletes text
// overlapping what the remote change deleted
// (https://github.com/meta/lexical/issues/9825). Yjs merges the deleted
// items once the write's transaction ends: the local deletion with the
// remote one the editor has not read yet. The next write split them only at
// the remote change's bounds, so an item holding text both deleted and text
// only the remote change deleted (which the editor still shows) counted as
// deleted again as a whole, the editor's text no longer matched the line it
// wrote to, and the listener's edit was stored past the end of the line (a
// paragraph of its own that the editor did not show). Writes now split items
// at the bounds of what was deleted again too. Found by a property-based run
// of mutation-listener sessions.

import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setSelection,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $selectIn,
  expectConverged,
  freshReader,
  setup,
} from '../../utils/harness';

describe.each([false, true])(
  'a listener edit beside a local delete overlapping a remote one read later, gc %s',
  gc => {
    test('is stored as the editor shows it', async () => {
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
      let budget = 3;
      a.editor.registerMutationListener(
        TextNode,
        mutations => {
          if (budget > 0 && mutations.size > 0) {
            budget--;
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
          $setSelection(null);
        });
        const remote = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc));
        a.update(() => {
          $selectIn([1], 7, 11).removeText();
          $setSelection(null);
          Y.applyUpdate(a.doc, remote, 'provider');
        });
        await Promise.resolve();
        await t.sync();
        await t.sync();
        const fresh = await freshReader(a);
        const stored = fresh.describe();
        fresh.stop();
        expect(a.describe()).toBe(
          'paragraph("two three four") / paragraph("eight nen###")',
        );
        expect(stored).toBe(a.describe());
        await expectConverged([a, b, t.c]);
      } finally {
        host.remove();
      }
    });
  },
);
