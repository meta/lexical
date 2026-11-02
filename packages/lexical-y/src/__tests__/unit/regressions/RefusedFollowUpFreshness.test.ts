/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// Follow-ups in a row that are read again (here BlockIdExtension's tag on
// inserted paragraphs, then on emptying the list item that holds a nested
// list), discrete and batched, with and without BlockIdExtension, a list
// starting at 1 and at 7: right after each update (before anything is
// awaited) the author shows the list numbering a fresh reader shows. Three
// or more follow-ups before reach the fourth re-read in a row, which runs no
// refresh (#9632, an accepted limit: DECISIONS.md D90, y.md's Limits):
// `test.fails`, so that a change of the limit shows here.
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
} from '@lexical/list';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
  type ElementNode,
  type LexicalEditor,
} from 'lexical';
import {expect, test} from 'vitest';

import {freshReader, setup} from '../../utils/harness';

const values = (editor: LexicalEditor) =>
  editor.read(() =>
    (
      $getRoot()
        .getChildren()
        .find(n => n.getType() === 'list') as ElementNode
    )
      .getChildren()
      .map(n => ($isListItemNode(n) ? n.getValue() : -1)),
  );
for (const start of [1, 7])
  for (const before of [0, 3, 6, 12])
    for (const batch of [false, true])
      for (const blockIds of [false, true])
        // #9632 (D90, accepted limit): the fourth re-read in a row runs no
        // refresh.
        (before >= 3 ? test.fails : test)(
          `sync derived start=${start} before=${before} batch=${batch} idsExtension=${blockIds}`,
          async () => {
            const t = await setup(
              () =>
                $getRoot().append(
                  $createParagraphNode().append($createTextNode('first')),
                  $createListNode('number', start).append(
                    $createListItemNode().append($createTextNode('one')),
                    $createListItemNode().append(
                      $createListNode('bullet').append(
                        $createListItemNode().append($createTextNode('nested')),
                      ),
                    ),
                  ),
                  $createParagraphNode().append($createTextNode('last')),
                ),
              {withBlockIds: blockIds},
            );
            try {
              expect(values(t.a.editor), 'first synchronous read').toEqual([
                start,
                start + 1,
              ]);
              for (let i = 0; i <= before; i++) {
                t.a.editor.update(
                  () => {
                    if (i < before)
                      $getRoot().append(
                        $createParagraphNode().append(
                          $createTextNode('refused'),
                        ),
                      );
                    else
                      (
                        (
                          $getRoot()
                            .getChildren()
                            .find(n => n.getType() === 'list') as ElementNode
                        ).getChildAtIndex(1) as ElementNode
                      ).clear();
                    $setSelection(null);
                  },
                  batch
                    ? {tag: 'block-id-repair'}
                    : {discrete: true, tag: 'block-id-repair'},
                );
                // editor.read force-commits a batched update. This assertion is before any await.
                const got = values(t.a.editor);
                // Both insertions and this nested-wrapper clear are refused and re-read.
                expect(got, 'synchronous derived fields').toEqual([
                  start,
                  start + 1,
                ]);
                const fresh = await freshReader(t.a);
                try {
                  expect(values(t.a.editor)).toEqual(values(fresh.editor));
                  expect(t.a.json()).toEqual(fresh.json());
                } finally {
                  fresh.stop();
                }
                await t.sync();
                expect(t.b.json()).toEqual(t.a.json());
              }
            } finally {
              for (const p of t.peers) p.stop();
            }
          },
        );
