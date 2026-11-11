/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A keep D88 never released. In a table cell, B's undo manager keeps a
// character B deleted and, walking up, the cell, row and table items (Yjs
// keepItem). B then formats text in the cell: the binding keeps the format
// item and walks up, finding the containers kept already (by that step). B
// clears its undo history: Yjs releases the containers, and the binding
// keeps again what it relies on (another undo manager may rely on them too:
// Yjs's keep is one flag), then left them to the step that had let them go.
// The table, row and cell stayed kept for the document's life, also after
// the binding stopped, so a collaborator's later delete of the table was
// never collected. What a binding keeps again is released when it stops.
import {$patchStyleText} from '@lexical/selection';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isParagraphNode,
  $setSelection,
  type ElementNode,
  type LexicalNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {createBoundEditor, setup} from '../../utils/harness';

function $paragraphs(): ElementNode[] {
  const out: ElementNode[] = [];
  const walk = (n: LexicalNode) => {
    if ($isParagraphNode(n)) out.push(n);
    else if ($isElementNode(n)) n.getChildren().forEach(walk);
  };
  walk($getRoot());
  return out;
}
function $sel(p: number, from: number, to: number) {
  const t = $paragraphs()[p].getAllTextNodes()[0];
  const s = $createRangeSelection();
  s.anchor.set(t.getKey(), from, 'text');
  s.focus.set(t.getKey(), to, 'text');
  $setSelection(s);
  return s;
}
const liveKept = (doc: Y.Doc) => {
  const out: string[] = [];
  for (const structs of doc.store.clients.values()) {
    for (const s of structs) {
      if (s instanceof Y.Item && s.keep && !s.deleted) {
        out.push(s.content.constructor.name);
      }
    }
  }
  return out;
};

for (const variant of ['bold', 'color'] as const) {
  for (const gc of [false, true]) {
    test(`B's keeps on a table's containers are released when it stops after a clear (${variant}, gc ${gc ? 'on' : 'off'})`, async () => {
      const $cell = (text: string) =>
        $createTableCellNode(0).append(
          $createParagraphNode().append($createTextNode(text)),
        );
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('before the table')),
            $createTableNode().append(
              $createTableRowNode().append(
                $cell('one two three four five six'),
                $cell('seven eight nine'),
              ),
            ),
            $createParagraphNode().append($createTextNode('after the table')),
          ),
        {gc, ids: [1, 2]},
      );
      try {
        // B deletes a character in the first cell (its undo manager keeps it and the cell, row, table)
        t.b.update(() => {
          $sel(1, 3, 4).removeText();
          $setSelection(null);
        });
        t.b.binding.undoManager?.stopCapturing();
        // B formats text in the same cell (the binding keeps the format items and walks up)
        t.b.update(() => {
          const s = $sel(1, 4, 8);
          if (variant === 'bold') s.formatText('bold');
          else $patchStyleText(s, {color: '#00c'});
          $setSelection(null);
        });
        await t.sync();
        t.b.binding.undoManager!.clear();
        t.b.stop();
        expect(liveKept(t.b.doc)).toEqual([]);
        // A then deletes the table: with gc on, B's document collects it.
        t.a.update(() => {
          $getRoot().getChildAtIndex(1)!.remove();
        });
        await t.sync();
        if (gc) {
          const leftover: string[] = [];
          for (const structs of t.b.doc.store.clients.values()) {
            for (const s of structs) {
              if (
                s instanceof Y.Item &&
                s.deleted &&
                s.content instanceof Y.ContentType
              ) {
                leftover.push(`${s.id.client}:${s.id.clock}`);
              }
            }
          }
          expect(leftover).toEqual([]);
        }
      } finally {
        t.peers.forEach(p => p.stop());
      }
    });
  }
}

// Two bindings on one document keep the same containers: what one of them
// kept again after its clear is released by the last of them to stop.
for (const order of ['second stops first', 'first stops first'] as const) {
  for (const gc of [false, true]) {
    test(`two bindings: the last to stop releases the containers (${order}, gc ${gc ? 'on' : 'off'})`, async () => {
      const $cell = (text: string) =>
        $createTableCellNode(0).append(
          $createParagraphNode().append($createTextNode(text)),
        );
      const t = await setup(
        () =>
          $getRoot().append(
            $createTableNode().append(
              $createTableRowNode().append(
                $cell('one two three four five six'),
              ),
            ),
            $createParagraphNode().append($createTextNode('after the table')),
          ),
        {gc, ids: [1, 2]},
      );
      const second = createBoundEditor(t.b.doc, {
        namespace: 'second',
        nodes: t.b.nodes,
        onError: e => {
          throw e;
        },
        onWarn: () => {},
        selfCheck: true,
      });
      let stopSecond: (() => void) | null = second.start();
      try {
        t.b.update(() => {
          $sel(0, 3, 4).removeText();
          $setSelection(null);
        });
        t.b.binding.undoManager?.stopCapturing();
        t.b.update(() => {
          $sel(0, 4, 8).formatText('bold');
          $setSelection(null);
        });
        second.editor.update(
          () => {
            // The last text node of the cell's paragraph, past B's bold.
            const texts = $paragraphs()[0].getAllTextNodes();
            const last = texts[texts.length - 1];
            const s = $createRangeSelection();
            s.anchor.set(last.getKey(), 1, 'text');
            s.focus.set(last.getKey(), 3, 'text');
            $setSelection(s);
            s.formatText('italic');
            $setSelection(null);
          },
          {discrete: true},
        );
        if (order === 'second stops first') {
          second.binding.undoManager!.clear();
          stopSecond();
          stopSecond = null;
          t.b.binding.undoManager!.clear();
          t.b.stop();
        } else {
          t.b.binding.undoManager!.clear();
          t.b.stop();
          second.binding.undoManager!.clear();
          stopSecond();
          stopSecond = null;
        }
        expect(liveKept(t.b.doc)).toEqual([]);
      } finally {
        if (stopSecond !== null) {
          stopSecond();
        }
        t.peers.forEach(p => p.stop());
      }
    });
  }
}
