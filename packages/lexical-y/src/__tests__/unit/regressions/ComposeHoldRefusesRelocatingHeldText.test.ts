/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A composes `abc` in an inline container (Box) inside a numbered-list
// item; B changes the text's format and types R in it, which A's hold keeps
// back (stored `aRbc`, shown `abc`). A local edit of A's then moves that
// item (to the end of its list, into the other list, or nested under a new
// item), or unwraps the Box into the item. Writing the Box (or its text)
// anew from what A shows would delete R with the old shared node, or leave
// it behind, as main does. The edit is refused before it writes anything:
// no local Yjs update that writes content, one UNSUPPORTED_EDIT_WARNING
// (`'held-composition'`), and A reads the document again, so the move is
// undone, and every peer and a fresh reader hold R and B's format where
// they were. The same for a line composed straight in the item, or in a
// table cell whose row moves, and for a move that also edits the text
// composed in.
//
// Deleting the Box itself is refused too (what the update did with its text,
// removed or merged into another node, is not told apart); the user deletes
// it again once the composition ends.

import {
  $createListItemNode,
  $createListNode,
  type ListItemNode,
  type ListNode,
} from '@lexical/list';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  type TableNode,
} from '@lexical/table';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getRoot,
  $setCompositionKey,
  $setSelection,
  ElementNode,
  type TextNode,
} from 'lexical';
import {expect, onTestFinished, test} from 'vitest';

import {freshReader, NODES, setup} from '../../utils/harness';

/** One warning: the refusal of an edit for what a composition holds back. */
function expectHeldRefusal(warnings: string[]): void {
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(
    'would delete or leave behind text a collaborator wrote in the line being composed',
  );
}

class Box extends ElementNode {
  $config() {
    return this.config('hold_text_box', {
      children: 'inline',
      extends: ElementNode,
    });
  }
  isInline() {
    return true;
  }
  createDOM() {
    return $getDocument().createElement('span');
  }
  updateDOM() {
    return false;
  }
}

type Edit = 'move' | 'other list' | 'nest' | 'unwrap' | 'delete';
type Shape = 'box' | 'line';

const $text = (): TextNode =>
  $getRoot()
    .getAllTextNodes()
    .find(n => n.getTextContent().startsWith('a'))!;

async function run(
  edit: Edit,
  shape: Shape,
  bold: boolean,
  gc: boolean,
  ids: number[],
  also: 'append' | 'italic' | null = null,
) {
  const t = await setup(
    () => {
      const text = $createTextNode('abc').setFormat(bold ? 1 : 0);
      $getRoot().append(
        $createListNode('number').append(
          $createListItemNode().append(
            shape === 'box' ? $create(Box).append(text) : text,
          ),
          $createListItemNode().append($createTextNode('tail')),
        ),
        $createParagraphNode().append($createTextNode('separator')),
        $createListNode('number', 7).append(
          $createListItemNode().append($createTextNode('other')),
        ),
      );
    },
    {gc, ids, nodes: [...NODES, Box]},
  );
  const {a, b} = t;
  const host = document.createElement('div');
  host.contentEditable = 'true';
  document.body.append(host);
  a.editor.setRootElement(host);
  host.focus();
  onTestFinished(() => {
    a.editor.setRootElement(null);
    host.remove();
    t.peers.forEach(p => p.stop());
  });
  // A composes in `abc`; B unformats (or bolds) it and types R in it.
  a.update(() => {
    const n = $text();
    n.select(1, 1);
    $setCompositionKey(n.getKey());
  });
  await t.sync();
  b.update(() => {
    const n = $text();
    n.setFormat(bold ? 0 : 1);
    n.spliceText(1, 0, 'R');
    $setSelection(null);
  });
  await t.sync();
  expect(a.describe()).not.toContain('R');
  // What B holds now, which a refused edit leaves A showing.
  const stored = b.describe();
  // What A's edit writes: its local Yjs updates that write content (the
  // text format and style Lexical derives for an element, which a read
  // can make A store, aside) and its clock.
  let localUpdates = 0;
  let derived = 0;
  const countLocal = (
    _u: Uint8Array,
    _origin: unknown,
    _doc: unknown,
    tr: {local: boolean; changed: Map<unknown, Set<string | null>>},
  ) => {
    if (!tr.local) {
      return;
    }
    const keys = [...tr.changed.values()].flatMap(set => [...set]);
    if (
      keys.length > 0 &&
      keys.every(k => k === 'p:textFormat' || k === 'p:textStyle')
    ) {
      derived++;
    } else {
      localUpdates++;
    }
  };
  const clockBefore = a.doc.store.getClock(a.doc.clientID);
  a.doc.on('update', countLocal);
  // A's own edit, while the hold is on (and a change of the text composed
  // in, in the same update).
  a.update(() => {
    if (also === 'append') {
      const n = $text();
      n.setTextContent(n.getTextContent() + 'X');
    } else if (also === 'italic') {
      $text().toggleFormat('italic');
    }
    const root = $getRoot();
    const first = root.getFirstChildOrThrow() as ListNode;
    const item = first.getFirstChildOrThrow() as ListItemNode;
    const other = root.getLastChildOrThrow() as ListNode;
    if (edit === 'move') {
      first.append(item);
    } else if (edit === 'other list') {
      other.append(item);
    } else if (edit === 'nest') {
      first.append(
        $createListItemNode().append($createListNode('number').append(item)),
      );
    } else {
      const box = item.getFirstChildOrThrow() as ElementNode;
      if (edit === 'unwrap') {
        for (const child of box.getChildren()) {
          box.insertBefore(child);
        }
      }
      box.remove();
    }
  });
  await t.sync();
  a.doc.off('update', countLocal);
  const clockAfter = a.doc.store.getClock(a.doc.clientID);
  a.update(() => $setCompositionKey(null));
  await t.sync();
  const fresh = await freshReader(a);
  onTestFinished(() => fresh.stop());
  return {
    a,
    clockAfter: derived > 0 ? clockBefore : clockAfter,
    clockBefore,
    fresh,
    localUpdates,
    stored,
    t,
  };
}

for (const gc of [false, true]) {
  for (const ids of [
    [1, 2, 3],
    [3, 2, 1],
  ]) {
    for (const bold of [false, true]) {
      for (const [edit, shape] of [
        ['move', 'box'],
        ['other list', 'box'],
        ['nest', 'box'],
        ['unwrap', 'box'],
        ['move', 'line'],
        ['other list', 'line'],
        ['nest', 'line'],
      ] as [Edit, Shape][]) {
        test(`a local ${edit} of the item composed in (${shape}) is refused: nothing is written, the edit is undone, and R and B's format stay (bold ${bold}, ids ${ids}, gc ${gc})`, async () => {
          const {a, clockAfter, clockBefore, fresh, localUpdates, stored, t} =
            await run(edit, shape, bold, gc, ids);
          expect(localUpdates).toBe(0);
          expect(clockAfter).toBe(clockBefore);
          expect(a.describe()).toBe(stored);
          expect(fresh.describe()).toBe(stored);
          for (const p of t.peers) {
            expect(p.describe()).toBe(stored);
          }
          expect(a.read(() => $text().getFormat())).toBe(bold ? 0 : 1);
          expectHeldRefusal(a.warnings);
        });
      }
      test(`deleting the inline container composed in is refused too: R and the composed text stay (bold ${bold}, ids ${ids}, gc ${gc})`, async () => {
        const {a, clockAfter, clockBefore, fresh, localUpdates, stored, t} =
          await run('delete', 'box', bold, gc, ids);
        expect(localUpdates).toBe(0);
        expect(clockAfter).toBe(clockBefore);
        expect(a.describe()).toBe(stored);
        expect(fresh.describe()).toBe(stored);
        for (const p of t.peers) {
          expect(p.describe()).toBe(stored);
        }
        expectHeldRefusal(a.warnings);
      });
    }
  }
}

for (const gc of [false, true]) {
  for (const edit of ['after the next row', 'to the end', 'next row deleted']) {
    test(`${edit === 'next row deleted' ? "deleting the row after the one composed in is written, and keeps R and B's format" : `a local move of the table row composed in (${edit}) is refused: R and B's format stay`} (gc ${gc})`, async () => {
      const t = await setup(
        () => {
          const $row = (s: string) =>
            $createTableRowNode().append(
              $createTableCellNode().append(
                $createParagraphNode().append($createTextNode(s)),
              ),
              $createTableCellNode().append(
                $createParagraphNode().append($createTextNode(s + '2')),
              ),
            );
          $getRoot().append(
            $createTableNode().append($row('abc'), $row('xyz')),
            $createParagraphNode().append($createTextNode('after')),
          );
        },
        {gc, ids: [1, 2, 3]},
      );
      const {a, b} = t;
      const host = document.createElement('div');
      host.contentEditable = 'true';
      document.body.append(host);
      a.editor.setRootElement(host);
      host.focus();
      onTestFinished(() => {
        a.editor.setRootElement(null);
        host.remove();
        t.peers.forEach(p => p.stop());
      });
      a.update(() => {
        const n = $text();
        n.select(1, 1);
        $setCompositionKey(n.getKey());
      });
      await t.sync();
      b.update(() => {
        const n = $text();
        n.setFormat(1);
        n.spliceText(1, 0, 'R');
        $setSelection(null);
      });
      await t.sync();
      const stored = b.describe();
      a.update(() => {
        const table = $getRoot().getFirstChildOrThrow() as TableNode;
        const [first, second] = table.getChildren();
        if (edit === 'after the next row') {
          second.insertAfter(first);
        } else if (edit === 'to the end') {
          table.append(first);
        } else {
          second.remove();
        }
      });
      await t.sync();
      a.update(() => $setCompositionKey(null));
      await t.sync();
      const fresh = await freshReader(a);
      onTestFinished(() => fresh.stop());
      expect(a.describe()).toContain('"aRbc"{1}');
      expect(fresh.describe()).toBe(a.describe());
      for (const p of t.peers) {
        expect(p.describe()).toBe(a.describe());
      }
      if (edit === 'next row deleted') {
        // Not a move of what the hold holds items in: written.
        expect(a.describe()).not.toContain('xyz');
        expect(a.warnings).toEqual([]);
      } else {
        expect(a.describe()).toBe(stored);
        expectHeldRefusal(a.warnings);
      }
    });
  }
}

for (const gc of [false, true]) {
  test(`a local move of an inline container composed in that holds a node of its own is refused, and keeps the held text (gc ${gc})`, async () => {
    const t = await setup(
      () => {
        $getRoot().append(
          $createListNode('number').append(
            $createListItemNode().append(
              $create(Box).append(
                $createTextNode('abc'),
                $create(Box).append($createTextNode('inner')),
              ),
            ),
            $createListItemNode().append($createTextNode('tail')),
          ),
        );
      },
      {gc, ids: [1, 2, 3], nodes: [...NODES, Box]},
    );
    const {a, b} = t;
    const host = document.createElement('div');
    host.contentEditable = 'true';
    document.body.append(host);
    a.editor.setRootElement(host);
    host.focus();
    onTestFinished(() => {
      a.editor.setRootElement(null);
      host.remove();
      t.peers.forEach(p => p.stop());
    });
    a.update(() => {
      const n = $text();
      n.select(1, 1);
      $setCompositionKey(n.getKey());
    });
    await t.sync();
    b.update(() => {
      $text().spliceText(1, 0, 'R');
      $setSelection(null);
    });
    await t.sync();
    a.update(() => {
      const list = $getRoot().getFirstChildOrThrow() as ListNode;
      list.append(list.getFirstChildOrThrow());
    });
    await t.sync();
    a.update(() => $setCompositionKey(null));
    await t.sync();
    const fresh = await freshReader(a);
    onTestFinished(() => fresh.stop());
    expect(a.describe()).toContain('aRbc');
    // The move is undone: the item composed in is first again.
    expect(a.describe().indexOf('aRbc')).toBeLessThan(
      a.describe().indexOf('tail'),
    );
    expect(fresh.describe()).toBe(a.describe());
    for (const p of t.peers) {
      expect(p.describe()).toBe(a.describe());
    }
    expectHeldRefusal(a.warnings);
  });
}

for (const gc of [false, true]) {
  for (const bold of [false, true]) {
    for (const shape of ['box', 'line'] as Shape[]) {
      // Typing in the same update: written as made, so that no typed
      // character is undone (see $heldDecision); the move goes through and
      // the collaborator's held R goes with the old item, as main writes it.
      test(`a local move of the item composed in (${shape}) that also types in the text composed in is written: the typing is kept, and every peer agrees (bold ${bold}, gc ${gc})`, async () => {
        const {a, fresh, t} = await run(
          'move',
          shape,
          bold,
          gc,
          [1, 2, 3],
          'append',
        );
        const shown = a.describe();
        expect(shown).toContain('X');
        expect(fresh.describe()).toBe(shown);
        for (const p of t.peers) {
          expect(p.describe()).toBe(shown);
        }
        expect(a.warnings).toEqual([]);
      });
      if (shape === 'box') {
        test.fails(
          `an update that types and moves the container being composed in loses the collaborator's held text, as main does (bold ${bold}, gc ${gc})`,
          async () => {
            const {fresh} = await run(
              'move',
              shape,
              bold,
              gc,
              [1, 2, 3],
              'append',
            );
            expect(fresh.describe()).toContain('R');
          },
        );
      } else {
        // A line has no shared node: R stays where the line was (see
        // Cursor#counts), kept once.
        test(`an update that types and moves the line being composed in keeps the collaborator's held text once, where the line was (bold ${bold}, gc ${gc})`, async () => {
          const {fresh} = await run(
            'move',
            shape,
            bold,
            gc,
            [1, 2, 3],
            'append',
          );
          expect(fresh.describe().split('R')).toHaveLength(2);
        });
      }
      for (const also of ['italic'] as const) {
        test(`a local move of the item composed in (${shape}) that also changes the format of the text composed in is refused: R is kept, nothing is written, the move and the edit are undone (bold ${bold}, gc ${gc})`, async () => {
          const {a, clockAfter, clockBefore, fresh, localUpdates, t} =
            await run('move', shape, bold, gc, [1, 2, 3], also);
          expect(localUpdates).toBe(0);
          expect(clockAfter).toBe(clockBefore);
          const shown = a.describe();
          expect(shown).toContain(bold ? '"aRbc"' : '"aRbc"{1}');
          expect(shown).not.toContain('X');
          expect(shown.indexOf('aRbc')).toBeLessThan(shown.indexOf('tail'));
          expect(a.read(() => $text().getFormat())).toBe(bold ? 0 : 1);
          expect(fresh.describe()).toBe(shown);
          for (const p of t.peers) {
            expect(p.describe()).toBe(shown);
          }
          expectHeldRefusal(a.warnings);
        });
      }
    }
  }
}
