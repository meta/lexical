/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A refused follow-up (a transform registered while the document is open
// inserts a paragraph; the binding does not write it and reads the root
// again) must leave the local caret where it was, with the self-check off,
// gc off or on, block ids off or on (R6-B's repro of the 1,280-character
// deletion). The control maps the cursor around the re-read itself.
import {
  BlockIdExtension,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$createListItemNode, $createListNode} from '@lexical/list';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  configExtension,
  defineExtension,
  ParagraphNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YCollabExtension} from '../..';
import {NODES} from '../utils/harness';

const idle = async () => {
  for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r));
};
const $item = (s: string) => $createListItemNode().append($createTextNode(s));
for (const gc of [false, true])
  for (const ids of [false, true])
    for (const control of [false, true])
      test(`public refused refresh gc=${gc} ids=${ids} selection mapping control=${control}`, async () => {
        const peers = [1, 2].map(id => {
          const doc = createYDoc(null, {gc});
          doc.clientID = id;
          const editor = buildEditorFromExtensions(
            defineExtension({
              $initialEditorState: null,
              dependencies: [
                configExtension(YCollabExtension, {
                  doc,
                  schemaVersion: 1,
                  selfCheck: false,
                }),
                ...(ids ? [BlockIdExtension] : []),
              ],
              name: 'R6/caret/' + id,
              nodes: NODES,
              onError: e => {
                throw e;
              },
              onWarn: () => {},
            }),
          );
          const binding = getExtensionDependencyFromEditor(
            editor,
            YCollabExtension,
          ).output.binding;
          return {binding, doc, editor};
        });
        const [a, b] = peers;
        const sync = async () => {
          for (let r = 0; r < 3; r++) {
            for (const p of peers)
              for (const q of peers)
                if (p !== q)
                  Y.applyUpdate(p.doc, Y.encodeStateAsUpdate(q.doc), 'network');
            await idle();
          }
        };
        try {
          a.editor.update(
            () => {
              $getRoot().append(
                $createListNode('bullet').append(
                  $item('A top'),
                  $createListItemNode().append(
                    $createListNode('bullet').append(
                      $item('A nested one'),
                      $item('A nested two'),
                      $item('A nested three'),
                    ),
                  ),
                  $item('A after'),
                ),
                $createParagraphNode().append($createTextNode('between')),
                $createListNode('bullet').append(
                  $item('B top'),
                  $createListItemNode().append(
                    $createListNode('bullet').append(
                      $item('B nested one'),
                      $createListItemNode().append(
                        $createTextNode('B nested '),
                        $createTextNode('two').toggleFormat('bold'),
                      ),
                    ),
                  ),
                  $item('B after'),
                ),
                $createParagraphNode().append($createTextNode('last')),
              );
            },
            {discrete: true},
          );
          a.binding.initialize();
          await sync();
          b.editor.update(
            () => {
              $getRoot()
                .getAllTextNodes()
                .find(t => t.getTextContent() === 'two')!
                .select(2, 2);
            },
            {discrete: true},
          );
          const readCaret = () =>
            b.editor.getEditorState().read(() => {
              const s = $getSelection();
              if (!$isRangeSelection(s)) return null;
              return {
                collapsed: s.isCollapsed(),
                offset: s.anchor.offset,
                text: s.anchor.getNode().getTextContent(),
                type: s.anchor.type,
              };
            });
          const before = readCaret();
          let calls = 0;
          const bb = b.binding as unknown as {
            $rereadRefused: () => unknown;
            $restoreSelection: (cursor: unknown, keepCaret?: boolean) => void;
          };
          const original = bb.$rereadRefused.bind(bb);
          bb.$rereadRefused = () => {
            calls++;
            const cursor = control ? b.binding.getCursor() : null;
            const after = original();
            if (cursor) bb.$restoreSelection(cursor, true);
            return after;
          };
          const un = b.editor.registerNodeTransform(ParagraphNode, p => {
            if (p.getNextSibling() === null && p.getTextContent() !== 'end')
              p.insertAfter(
                $createParagraphNode().append($createTextNode('end')),
              );
          });
          await idle();
          un();
          const after = readCaret();
          const previousText = b.editor
            .getEditorState()
            .read(() => $getRoot().getTextContent());
          b.editor.update(
            () => {
              const s = $getSelection();
              if ($isRangeSelection(s)) {
                if (s.anchor.type === 'text') {
                  s.anchor
                    .getNode()
                    .select(Math.max(0, s.anchor.offset - 1), s.anchor.offset)
                    .insertText('');
                } else {
                  s.deleteCharacter(true);
                }
              }
            },
            {discrete: true},
          );
          await sync();
          const finalText = b.editor
            .getEditorState()
            .read(() => $getRoot().getTextContent());
          // eslint-disable-next-line no-console
          console.log(
            'R6-CARET',
            JSON.stringify({
              after,
              before,
              calls,
              control,
              finalText,
              gc,
              ids,
              removed: previousText.length - finalText.length,
            }),
          );
          expect(
            calls,
            'public registration pass must reach reread',
          ).toBeGreaterThan(0);
          expect(
            after,
            'a read must not move a caret into another list',
          ).toEqual(before);
          expect(finalText).toContain('A nested one');
          expect(finalText).toContain('A nested two');
          expect(finalText).toContain('A nested three');
          expect(finalText).toContain('B nested to');
          expect(a.editor.getEditorState().toJSON()).toEqual(
            b.editor.getEditorState().toJSON(),
          );
        } finally {
          for (const p of peers) {
            p.editor.dispose();
            p.doc.destroy();
          }
        }
      });
