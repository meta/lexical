/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// No line around a block node has a marker: text left without one before
// it, the block node, and text left without one after it ("Title" [widget]
// " XX", from three clients' concurrent edits, or "Head" ¶ "before" [widget]
// "after", in the root or a callout). An update deletes the block node and
// the line after it (or the one before, or both). The write deletes exactly
// those: a follow-up's delete of the line after the block node started at
// the end item before the block node, which there is none of, or which is
// before the line before it, and deleted that line too (soak S4-3: every
// reader showed an empty document while the author kept `Title`).

import {$createTableNodeWithDimensions} from '@lexical/table';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $setSelection,
  type ElementNode,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  BoxNode,
  describeNode,
  freshReader,
  type Peer,
  setup,
  WidgetNode,
} from '../utils/harness';

const tree = (p: Peer) =>
  p.read(() => $getRoot().getChildren().map(describeNode).join(' / '));

function deletedText(p: Peer) {
  const w = {deleted: ''};
  p.doc.on('afterTransaction', (tr: Y.Transaction) => {
    if (!tr.local) {
      return;
    }
    Y.iterateStructsByIdSet(tr, tr.deleteSet, s => {
      if (s instanceof Y.Item && s.content instanceof Y.ContentString) {
        w.deleted += s.content.str;
      }
    });
  });
  return w;
}

/**
 * As a plain Yjs client, deletes the markers of `type`'s own sequence whose
 * position among them `which` picks.
 */
function unmark(
  doc: Y.Doc,
  type: Y.Node,
  which: (i: number, n: number) => boolean,
) {
  const at: number[] = [];
  let idx = 0;
  for (let it = type._start; it !== null; it = it.right) {
    if (it.deleted || !it.countable) {
      continue;
    }
    if (it.content instanceof Y.ContentType && it.content.type.name === '¶') {
      at.push(idx);
    }
    idx += it.length;
  }
  const picked = at.filter((_, i) => which(i, at.length)).reverse();
  doc.transact(() => {
    for (const i of picked) {
      type.delete(i, 1);
    }
  });
}

/** Applies `edit`, made on a copy of A's document, to both peers. */
async function fromOutside(
  t: {a: Peer; b: Peer; sync(): Promise<void>},
  edit: (doc: Y.Doc) => void,
) {
  const out = new Y.Doc();
  Y.applyUpdate(out, Y.encodeStateAsUpdate(t.a.doc));
  const sv = Y.encodeStateVector(out);
  edit(out);
  const update = Y.encodeStateAsUpdate(out, sv);
  Y.applyUpdate(t.a.doc, update, 'net');
  Y.applyUpdate(t.b.doc, update, 'net');
  await t.sync();
}

describe('three clients leave no marker around a widget', () => {
  // A joins Title and two, C removes the line two, B puts a widget after
  // Title and types into two: "Title" [widget] " XX".
  for (const tag of ['block-id-repair', undefined] as const) {
    for (const actor of ['a', 'b', 'c'] as const) {
      test(`${actor.toUpperCase()}'s update${tag ? ' (follow-up)' : ''} deletes the widget and the line after it`, async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('Title')),
              $createParagraphNode().append($createTextNode('two')),
            );
          },
          {ids: [1, 2, 3]},
        );
        t.offline();
        t.a.update(() => {
          const one = (
            $getRoot().getChildAtIndex(0) as ElementNode
          ).getFirstChild() as TextNode;
          const two = (
            $getRoot().getChildAtIndex(1) as ElementNode
          ).getFirstChild() as TextNode;
          const sel = $createRangeSelection();
          sel.anchor.set(one.getKey(), 5, 'text');
          sel.focus.set(two.getKey(), 0, 'text');
          $setSelection(sel);
          sel.removeText();
        });
        t.c!.update(() => {
          $getRoot().getLastChild()!.remove();
          $setSelection(null);
        });
        t.b.update(() => {
          $getRoot().getChildAtIndex(0)!.insertAfter($create(WidgetNode));
          $setSelection(null);
        });
        t.b.update(() => {
          ($getRoot().getLastChild() as ElementNode)
            .selectEnd()
            .insertText(' XX');
        });
        await t.sync();
        const p = t[actor]!;
        expect(tree(p)).toBe(
          'paragraph("Title") / test_widget / paragraph(" XX")',
        );
        const w = deletedText(p);
        p.update(() => {
          const kids = $getRoot().getChildren();
          kids[1].remove();
          kids[2].remove();
          $setSelection(null);
        }, tag);
        await t.sync();
        const fresh = await freshReader(p);
        expect(w.deleted).toBe(' XX');
        for (const q of t.peers) {
          expect(tree(q)).toBe('paragraph("Title")');
        }
        expect(tree(fresh)).toBe('paragraph("Title")');
      });
    }
  }
});

describe('no marker around a block node', () => {
  for (const block of ['table', 'widget'] as const) {
    for (const tag of ['block-id-repair', undefined] as const) {
      test(`${block}: an update${tag ? ' (follow-up)' : ''} deletes it and the line after it`, async () => {
        const t = await setup(() => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('Title')),
            block === 'table'
              ? $createTableNodeWithDimensions(1, 2, false)
              : $create(WidgetNode),
            $createParagraphNode().append($createTextNode('after')),
          );
        });
        await fromOutside(t, doc =>
          unmark(doc, doc.get('lexical-y'), () => true),
        );
        const w = deletedText(t.b);
        t.b.update(() => {
          const kids = $getRoot().getChildren();
          kids[1].remove();
          kids[2].remove();
          $setSelection(null);
        }, tag);
        await t.sync();
        const fresh = await freshReader(t.a);
        expect(w.deleted).toBe('after');
        expect(tree(t.a)).toBe('paragraph("Title")');
        expect(tree(t.b)).toBe('paragraph("Title")');
        expect(tree(fresh)).toBe('paragraph("Title")');
      });
    }
  }

  // "Head" ¶ "before" [widget] "after": in the root, and in a callout.
  for (const where of ['root', 'callout'] as const) {
    for (const what of ['after', 'before', 'both', 'none'] as const) {
      for (const tag of ['block-id-repair', undefined] as const) {
        test(`${where}: an update${tag ? ' (follow-up)' : ''} deletes the widget and ${what === 'none' ? 'no line' : what === 'both' ? 'both lines' : `the line ${what} it`}`, async () => {
          const t = await setup(() => {
            const lines = [
              $createParagraphNode().append($createTextNode('before')),
              $create(WidgetNode),
              $createParagraphNode().append($createTextNode('after')),
            ];
            const head = $createParagraphNode().append($createTextNode('Head'));
            if (where === 'root') {
              $getRoot().append(head, ...lines);
            } else {
              $getRoot().append(
                head,
                $create(BoxNode).append(...lines),
                $createParagraphNode().append($createTextNode('Tail')),
              );
            }
          });
          await fromOutside(t, doc => {
            const root = doc.get('lexical-y');
            if (where === 'root') {
              // Keep Head's marker.
              unmark(doc, root, i => i > 0);
            } else {
              for (let it = root._start; it !== null; it = it.right) {
                if (
                  !it.deleted &&
                  it.content instanceof Y.ContentType &&
                  String(it.content.type.name).startsWith('b:test_box')
                ) {
                  unmark(doc, it.content.type, () => true);
                }
              }
            }
          });
          const w = deletedText(t.b);
          t.b.update(() => {
            const parent: ElementNode =
              where === 'root'
                ? $getRoot()
                : ($getRoot().getChildAtIndex(1) as ElementNode);
            const kids = parent.getChildren();
            const at = kids.findIndex(
              (k: LexicalNode) => k.getType() === 'test_widget',
            );
            const before = kids[at - 1];
            const after = kids[at + 1];
            kids[at].remove();
            if (what === 'after' || what === 'both') {
              after.remove();
            }
            if (
              (what === 'before' || what === 'both') &&
              $isElementNode(before)
            ) {
              before.remove();
            }
            $setSelection(null);
          }, tag);
          await t.sync();
          const fresh = await freshReader(t.a);
          expect(w.deleted).not.toContain('Head');
          expect(w.deleted).not.toContain('Tail');
          if (what === 'after') {
            expect(w.deleted).not.toContain('before');
          }
          if (what === 'before') {
            expect(w.deleted).not.toContain('after');
          }
          expect(tree(t.a)).toBe(tree(t.b));
          expect(tree(fresh)).toBe(tree(t.b));
        });
      }
    }
  }
});
