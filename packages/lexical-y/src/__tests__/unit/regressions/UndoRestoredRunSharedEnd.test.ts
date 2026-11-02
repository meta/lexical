/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// A run whose end is one the document already held (a comment's write reused
// an existing end), and a later, separate write by the same author that is
// undone: when a collaborator undoes removing the comment, the comment comes
// back on its surviving text up to that shared end. The author's later write
// has an end of its own that follows the original in the author's clocks, so
// it must not be taken for the original's end (#9689: a fix that did was
// parked in #9687).

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {
  $addMarkID,
  $getNodeMarkIDs,
  $removeMarkID,
  MarkStateExtension,
} from '@lexical/mark';
import {RichTextExtension} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
  configExtension,
  defineExtension,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YCollabExtension} from '../../..';
import {editYState, readYState, seedYState} from '../../../headless';
import {changeEnd} from '../../../internal/Cursor';
import {$selectIn} from '../../utils/harness';

const config = {
  extensions: [RichTextExtension, MarkStateExtension],
  schemaVersion: 1,
};

function $show() {
  return $getRoot()
    .getAllTextNodes()
    .map(node => [
      node.getTextContent(),
      [...$getNodeMarkIDs(MarkStateExtension, node)],
    ]);
}

function items(root: Y.Node) {
  const out: Y.Item[] = [];
  for (let item = root._start; item; item = item.right) {
    out.push(item);
  }
  return out;
}

for (const gc of [false, true]) {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    for (const concurrent of [false, true]) {
      for (const action of ['delete-prefix', 'undo-original'] as const) {
        test(`unrelated later end: ${action}, gc=${gc}, ids=${ids}, concurrent=${concurrent}`, () => {
          // A normal saved document after a comment has been removed. Its
          // live null is retained by D47/D86, and compaction has collected
          // its old opener. No Item is inserted or deleted by this test.
          const marked = seedYState(config, () => {
            const first = $createTextNode('tail');
            const last = $createTextNode('outside');
            $getRoot()
              .clear()
              .append(
                $createParagraphNode().append(first),
                $createParagraphNode().append(last),
              );
            $addMarkID('c1', first.select(0, 4));
            $addMarkID('other', last.select(0, 7));
          });
          const saved = editYState(marked, config, () => $removeMarkID('c1'), {
            writer: null,
          }).state;
          expect(readYState(saved, config, $show)).toEqual([
            ['tail', []],
            ['outside', ['other']],
          ]);
          const peers = ids.map(id => {
            const doc = createYDoc(saved, {gc});
            doc.clientID = id;
            const editor = buildEditorFromExtensions(
              defineExtension({
                dependencies: [
                  RichTextExtension,
                  MarkStateExtension,
                  configExtension(YCollabExtension, {
                    captureTimeout: 2 ** 30,
                    doc,
                    schemaVersion: 1,
                    synced: true,
                  }),
                ],
                name: `review9687/provenance/${id}`,
                onError: error => {
                  throw error;
                },
              }),
            );
            const {binding} = getExtensionDependencyFromEditor(
              editor,
              YCollabExtension,
            ).output;
            return {binding, doc, editor};
          });
          const [a, b] = peers;
          const sync = () => {
            for (const from of peers)
              for (const to of peers)
                if (from !== to) {
                  const clock = to.doc.store.getClock(to.doc.clientID);
                  Y.applyUpdate(
                    to.doc,
                    Y.encodeStateAsUpdate(
                      from.doc,
                      Y.encodeStateVector(to.doc),
                    ),
                  );
                  expect(
                    to.doc.store.getClock(to.doc.clientID),
                    'remote reads write nothing',
                  ).toBe(clock);
                }
          };
          try {
            a.editor.update(
              () => {
                const selection = $selectIn([0], 0);
                selection.format = 0;
                selection.insertNodes([$createTextNode('YY')]);
                $setSelection(null);
              },
              {discrete: true},
            );
            // Separate discrete updates, in the same undo step: the text
            // nodes merge before the one comment range is written.
            a.editor.update(
              () => {
                $addMarkID('c1', $selectIn([0], 0, 6));
                $setSelection(null);
              },
              {discrete: true},
            );
            a.binding.undoManager!.stopCapturing();
            const root = a.doc.get('lexical-y') as Y.Node;
            const opener = items(root).find(
              item =>
                item.id.client === a.doc.clientID &&
                item.content instanceof Y.ContentFormat &&
                item.content.key === 's:markIds\u001fc1' &&
                item.content.value === true,
            )!;
            expect(opener).toBeDefined();
            expect(
              changeEnd(a.doc, opener),
              'the original run reuses a shared end',
            ).toBe(null);
            sync();
            expect(b.editor.read($show)).toEqual([
              ['YYtail', ['c1']],
              ['outside', ['other']],
            ]);

            // A separate write removes c1 from tail. Undo it, returning to
            // YYtail[c1]. This write's end follows the original in client
            // clocks but never belonged to that original write.
            a.editor.update(
              () => {
                $removeMarkID('c1', $selectIn([0], 2, 6));
                $setSelection(null);
              },
              {discrete: true},
            );
            const unrelated = changeEnd(a.doc, opener)!;
            expect(unrelated).not.toBe(null);
            a.binding.undoManager!.stopCapturing();
            a.binding.undo();
            sync();
            expect(unrelated.deleted).toBe(true);
            const remoteEnd = b.doc.store.getItem(unrelated.id);
            expect(
              remoteEnd instanceof Y.Item &&
                remoteEnd.content instanceof Y.ContentFormat,
              'GC collects this remote, unrelated deleted format item',
            ).toBe(!gc);
            expect(
              changeEnd(a.doc, opener),
              'clock scan crosses a separate write',
            ).toBe(unrelated);
            expect(b.editor.read($show)).toEqual([
              ['YYtail', ['c1']],
              ['outside', ['other']],
            ]);

            b.editor.update(() => $removeMarkID('c1'), {discrete: true});
            b.binding.undoManager!.stopCapturing();
            if (!concurrent) sync();
            if (action === 'delete-prefix') {
              // The original comment is not undone. Its surviving tail
              // must be restored when B undoes removal of that comment.
              a.editor.update(
                () => {
                  $selectIn([0], 0, 2).removeText();
                  $setSelection(null);
                },
                {discrete: true},
              );
            } else {
              a.binding.undo();
            }
            sync();
            b.binding.undo();
            sync();
            const expected = [
              ['tail', ['c1']],
              ['outside', ['other']],
            ];
            const restored = peers.map(peer => peer.editor.read($show));
            expect(
              restored[1],
              'both clients agree before checking the oracle',
            ).toEqual(restored[0]);
            expect(
              readYState(Y.encodeStateAsUpdate(a.doc), config, $show),
              'a fresh reader agrees before checking the oracle',
            ).toEqual(restored[0]);
            for (const peer of peers) {
              expect(peer.doc.store.pendingStructs).toBe(null);
              expect(peer.doc.store.pendingDs).toBe(null);
            }
            expect(
              restored[0],
              'restore surviving text up to the actual shared end',
            ).toEqual(expected);
          } finally {
            for (const peer of peers) {
              peer.editor.dispose();
              peer.doc.destroy();
            }
          }
        });
      }
    }
  }
}
