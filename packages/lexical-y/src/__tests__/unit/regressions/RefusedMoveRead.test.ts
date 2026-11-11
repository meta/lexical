/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A read that reads several containers in full (the re-read of what a
// refused local update changed, a read of the whole document) is one read: a
// line one container sets aside, the read of another places again. The
// check that a read never drops a node the document still holds (#9513) ran
// after each container, and took a line a read-only client's refused move
// had put in another container for one the read dropped: it read the whole
// document again, with a recovered-read warning, for a refused edit.

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
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
  $createTextNode,
  $getRoot,
  configExtension,
  defineExtension,
  type ElementNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  createYDoc,
  isYWarning,
  RECOVERED_READ_WARNING,
  YCollabExtension,
} from '../../..';

function client(schemaVersion: number, selfCheck: boolean) {
  const doc = createYDoc(null, {gc: false});
  const warnings: Error[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        RichTextExtension,
        configExtension(TableExtension, {hasHorizontalScroll: false}),
        configExtension(YCollabExtension, {doc, schemaVersion, selfCheck}),
      ],
      name: `@lexical/y/test/refused-move-${schemaVersion}`,
      onError: e => {
        throw e;
      },
      onWarn: w => {
        warnings.push(w);
      },
    }),
  );
  const {binding} = getExtensionDependencyFromEditor(
    editor,
    YCollabExtension,
  ).output;
  return {binding, doc, editor, warnings};
}
type Client = ReturnType<typeof client>;

const sync = (from: Client, to: Client) =>
  Y.applyUpdate(
    to.doc,
    Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)),
  );
const show = (c: Client) =>
  c.editor.read(() =>
    JSON.stringify(
      $getRoot()
        .getChildren()
        .map(n =>
          n.getType() === 'table'
            ? (n as ElementNode)
                .getChildren()
                .map(r =>
                  (r as ElementNode)
                    .getChildren()
                    .map(x =>
                      (x as ElementNode)
                        .getChildren()
                        .map(p => p.getTextContent()),
                    ),
                )
            : n.getTextContent(),
        ),
    ),
  );
const $cell = (row: number, column: number) =>
  (
    ($getRoot().getFirstChildOrThrow() as ElementNode).getChildAtIndex(
      row,
    ) as ElementNode
  ).getChildAtIndex(column) as ElementNode;

describe('a read-only client refuses a move across containers', () => {
  for (const selfCheck of [false, true]) {
    for (const [name, $move] of [
      [
        'a cell line to the root',
        () => $getRoot().append($cell(0, 0).getLastChildOrThrow()),
      ],
      [
        'a root line into a cell',
        () => $cell(0, 0).append($getRoot().getLastChildOrThrow()),
      ],
      [
        'a cell line to another cell',
        () => $cell(1, 1).append($cell(0, 0).getLastChildOrThrow()),
      ],
    ] as const) {
      test(`${name} (selfCheck ${selfCheck})`, async () => {
        const newer = client(2, selfCheck);
        const older = client(1, selfCheck);
        newer.editor.update(
          () => {
            const table = $createTableNode();
            for (let r = 0; r < 2; r++) {
              const row = $createTableRowNode();
              for (let c = 0; c < 2; c++) {
                row.append(
                  $createTableCellNode().append(
                    $createParagraphNode().append(
                      $createTextNode(`r${r}c${c}`),
                    ),
                    $createParagraphNode().append(
                      $createTextNode(`r${r}c${c}b`),
                    ),
                  ),
                );
              }
              table.append(row);
            }
            $getRoot()
              .clear()
              .append(
                table,
                $createParagraphNode().append($createTextNode('after')),
              );
          },
          {discrete: true},
        );
        newer.binding.initialize();
        sync(newer, older);
        older.binding.initialize();
        await Promise.resolve();
        expect(older.binding.status).toBe('readonly');
        const before = show(older);
        const seen = older.warnings.length;
        older.editor.update($move, {discrete: true});
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(show(older)).toBe(before);
        expect(
          older.warnings
            .slice(seen)
            .filter(isYWarning)
            .filter(w => w.code === RECOVERED_READ_WARNING),
        ).toEqual([]);
        newer.editor.update(
          () =>
            ($cell(0, 0).getFirstChildOrThrow() as ElementNode)
              .selectEnd()
              .insertText(' typed'),
          {discrete: true},
        );
        sync(newer, older);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(show(older)).toBe(show(newer));
        older.editor.dispose();
        newer.editor.dispose();
      });
    }
  }
});
