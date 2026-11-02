/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// S9-1: a client read only (the document records a newer schema) refuses a
// local update and reads the content it changed again. Where that update
// removed stored nodes (a table column's cells), the read made them anew
// and gave each a second container state for its Y.Node, then read the
// first one into it as well: the remote changes later made inside those
// cells were read with the other state's items, and the client never showed
// them (it no longer matched its own document, self-check on or off).

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $deleteTableColumnAtSelection,
  $deleteTableRowAtSelection,
  $isTableCellNode,
  TableCellNode,
  TableExtension,
  TableNode,
  TableRowNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  configExtension,
  createEditor,
  defineExtension,
  type ElementNode,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  createYDoc,
  isYWarning,
  UNSUPPORTED_EDIT_WARNING,
  UNSUPPORTED_SCHEMA_WARNING,
  YBinding,
  YCollabExtension,
  type YDoc,
} from '../../..';

type Client = {
  binding: YBinding;
  doc: YDoc;
  editor: LexicalEditor & {dispose(): void};
  warnings: Error[];
};

/** The codes of the binding's warnings, with their reason where they give one. */
const codes = (warnings: Error[]) =>
  warnings.filter(isYWarning).map(w => {
    const reason = (w.data as {reason?: unknown} | undefined)?.reason;
    return typeof reason === 'string' ? `${w.code}:${reason}` : w.code;
  });

function client(schemaVersion: number, selfCheck: boolean): Client {
  const doc = createYDoc(null, {gc: false});
  const warnings: Error[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        RichTextExtension,
        TableExtension,
        configExtension(YCollabExtension, {doc, schemaVersion, selfCheck}),
      ],
      name: `@lexical/y/test/read-only-reread-${schemaVersion}`,
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

const sync = (from: Client, to: Client) =>
  Y.applyUpdate(
    to.doc,
    Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)),
  );

/** A row-major table of cell texts, and the paragraph after the table. */
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
                  (r as ElementNode).getChildren().map(x => x.getTextContent()),
                )
            : n.getTextContent(),
        ),
    ),
  );

const $cell = (row: number, column: number) => {
  const table = $getRoot().getFirstChildOrThrow() as ElementNode;
  const cell = (table.getChildAtIndex(row) as ElementNode).getChildAtIndex(
    column,
  );
  if (!$isTableCellNode(cell)) {
    throw new Error('not a cell');
  }
  return cell;
};

const $caretIn = (row: number, column: number) =>
  ($cell(row, column).getFirstChildOrThrow() as ElementNode).selectEnd();

describe('S9-1: a refused update that removed stored nodes, then remote changes inside them', () => {
  for (const selfCheck of [false, true]) {
    for (const [name, $refused] of [
      ['a column', () => $deleteTableColumnAtSelection()],
      ['a row', () => $deleteTableRowAtSelection()],
    ] as const) {
      test(`the read-only client deletes ${name}; the newer client types in its cells (selfCheck ${selfCheck})`, async () => {
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
        older.editor.update(
          () => {
            $caretIn(0, 0);
            $refused();
          },
          {discrete: true},
        );
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(show(older)).toBe(before);
        newer.editor.update(
          () => {
            $caretIn(0, 0).insertText(' typed');
            $caretIn(1, 0).insertText(' too');
          },
          {discrete: true},
        );
        sync(newer, older);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(show(newer)).toBe(
          JSON.stringify([
            [
              ['r0c0 typed', 'r0c1'],
              ['r1c0 too', 'r1c1'],
            ],
            'after',
          ]),
        );
        expect(show(older)).toBe(show(newer));
        // Read only, the refused update warned once; nothing was recovered
        // and the self-check found nothing.
        expect(codes(older.warnings)).toEqual([
          `${UNSUPPORTED_SCHEMA_WARNING}:newer`,
          `${UNSUPPORTED_EDIT_WARNING}:read-only`,
        ]);
        older.editor.dispose();
        newer.editor.dispose();
      });
    }
  }
});

// S9-3: an update an app's listener queues while the binding opens a
// document (an editable listener's reply to the editor turning not editable)
// ran inside the binding's read of the whole document, tagged as a remote
// change: where the document turned out read only it was neither written
// nor read again, and the editor kept showing it.
describe('S9-3: an update queued while the binding opens a document', () => {
  type Opener = {
    binding: YBinding;
    doc: YDoc;
    editor: LexicalEditor;
    replies: boolean[];
    warnings: Error[];
  };
  /** A binding started by hand, with the app's listener registered first. */
  function opener(
    schemaVersion: number,
    state: Uint8Array | null,
    reply: boolean,
  ): Opener {
    const doc = createYDoc(null, {gc: false});
    if (state !== null) {
      Y.applyUpdate(doc, state);
    }
    const warnings: Error[] = [];
    const editor = createEditor({
      nodes: [TableNode, TableRowNode, TableCellNode],
      onError: e => {
        throw e;
      },
      onWarn: w => {
        warnings.push(w);
      },
    });
    const binding = new YBinding(editor, doc, {schemaVersion, selfCheck: true});
    const replies: boolean[] = [];
    if (reply) {
      editor.registerEditableListener(editable => {
        replies.push(editable);
        editor.update(() =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('reply')),
          ),
        );
      });
    }
    binding.start();
    binding.initialize();
    return {binding, doc, editor, replies, warnings};
  }
  const blocks = (c: Opener) =>
    c.editor.read(() =>
      $getRoot()
        .getChildren()
        .map(n => n.getTextContent()),
    );
  const fresh = (c: Opener) => {
    const r = opener(1000, Y.encodeStateAsUpdate(c.doc), false);
    const out = blocks(r);
    r.binding.dispose();
    return out;
  };
  const idle = async () => {
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  };

  for (const cause of ['a newer schema', 'a newer layout', 'none'] as const) {
    test(`an editable listener's reply (${cause})`, async () => {
      const a = opener(cause === 'a newer schema' ? 2 : 1, null, false);
      a.editor.update(
        () =>
          $getRoot()
            .clear()
            .append($createParagraphNode().append($createTextNode('hello'))),
        {discrete: true},
      );
      a.binding.initialize();
      if (cause === 'a newer layout') {
        a.binding.root.setAttr('lexical-y:7', true);
      }
      await idle();
      const b = opener(1, Y.encodeStateAsUpdate(a.doc), true);
      await idle();
      if (cause === 'none') {
        expect(b.binding.status).toBe('active');
        // The reply to the opening (not editable yet) is part of what the
        // read of the document replaces, as the editor's pending state is;
        // the reply to the editor turning editable is a local update,
        // written.
        expect(b.replies).toEqual([false, true]);
        expect(blocks(b)).toEqual(['hello', 'reply']);
        expect(b.warnings).toEqual([]);
      } else {
        expect(b.binding.status).toBe('readonly');
        expect(b.replies).toEqual([false]);
        expect(blocks(b)).toEqual(['hello']);
        expect(
          codes(b.warnings).filter(c => c.startsWith(UNSUPPORTED_EDIT_WARNING)),
        ).toEqual([`${UNSUPPORTED_EDIT_WARNING}:read-only`]);
      }
      expect(blocks(b)).toEqual(fresh(b));
      if (cause === 'a newer layout') {
        // The writer is read only too.
        a.binding.dispose();
        b.binding.dispose();
        return;
      }
      // Later remote changes read in as well.
      a.editor.update(
        () =>
          ($getRoot().getFirstChildOrThrow() as ElementNode).append(
            $createTextNode(' world'),
          ),
        {discrete: true},
      );
      Y.applyUpdate(
        b.doc,
        Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)),
      );
      await idle();
      expect(blocks(b)).toEqual(fresh(b));
      expect(blocks(b)[0]).toBe('hello world');
      a.binding.dispose();
      b.binding.dispose();
    });
  }
});
