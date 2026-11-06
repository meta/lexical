/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// The last line of defence behind Writer#$endangersHeld: with the
// preflight switched off (its decision still taken), a local change that
// removes the inline container A composes in (which holds B's held R)
// reaches the writer. Where the change inserts no character, deleting the
// container throws before it is deleted (see withProtected) and the change
// is refused: the editor reads the document again, R kept. Where it types
// a character in the same update, the write is never stopped (that would
// undo the typing): the decision allows the deletes it foresaw (and would
// report in the console one it did not), and the typing is written.

import {
  $create,
  $createParagraphNode,
  $getDocument,
  $getRoot,
  $getSlot,
  $removeSlot,
  $setCompositionKey,
  $setSelection,
  $setSlot,
  ElementNode,
  ParagraphNode,
  TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test, vi} from 'vitest';

import {Writer} from '../../../internal/Write';
import {freshReader, NODES, type Peer, setup} from '../../utils/harness';

class Box extends ElementNode {
  $config() {
    return this.config('guard_box', {children: 'inline', extends: ElementNode});
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

class Host extends ParagraphNode {
  $config() {
    return this.config('guard_host', {
      extends: ParagraphNode,
      slots: ['title'],
    });
  }
}

const text = (p: Peer) =>
  p.read(() =>
    $getRoot()
      .getAllTextNodes()
      .map(n => n.getTextContent())
      .join('|'),
  );

const $composed = () =>
  (
    ($getRoot().getChildAtIndex(1) as ElementNode).getFirstChildOrThrow() as Box
  ).getFirstChildOrThrow() as TextNode;

describe('a write that would delete what a hold keeps, past the preflight', () => {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      for (const kind of [
        'none',
        'typed',
        'deleted first',
        'moved first',
        'moved first, container moved',
        'container moved, a fault after its copy',
      ] as const) {
        const typed = kind === 'typed';
        const title =
          kind === 'typed'
            ? 'with a typed character in another paragraph: written as made (the delete foreseen, allowed), the typing kept'
            : kind === 'none'
              ? 'with no typing: stopped before the delete, refused, and R kept'
              : kind === 'container moved, a fault after its copy'
                ? 'the container moved into another paragraph, and the write fails (any error) right after writing its copy there: finished in the same transaction, one update, the copy deleted, R kept once, every peer agrees'
                : kind === 'moved first, container moved'
                  ? "with another paragraph's text moved and the container moved into that paragraph, the text written before the guard stops the write: the recovery leaves the container where it is, never copies it (abc once), and R is kept"
                  : kind === 'moved first'
                    ? "with another paragraph's text moved after the container, written before the guard stops the write: the recovery writes the rest of the change and leaves the container (the move lands, R kept, no character lost)"
                    : "with another paragraph's text deleted, written before the guard stops the write: the recovery, decided as inserting nothing too, is stopped before the delete and refused; R kept, the deletion written stays, no character lost";
        test(`${title} (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
          const t = await setup(
            () =>
              $getRoot().append(
                $createParagraphNode().append(
                  $create(TextNode).setTextContent('x'),
                ),
                $createParagraphNode().append(
                  $create(Box).append($create(TextNode).setTextContent('abc')),
                ),
              ),
            {gc, ids, nodes: [...NODES, Box]},
          );
          const {a, b} = t;
          const dom = document.createElement('div');
          dom.contentEditable = 'true';
          document.body.append(dom);
          a.editor.setRootElement(dom);
          onTestFinished(() => {
            a.editor.setRootElement(null);
            dom.remove();
            t.peers.forEach(p => p.stop());
          });
          a.update(() => {
            const n = $composed();
            n.select(1, 1);
            $setCompositionKey(n.getKey());
          });
          await t.sync();
          b.update(() => {
            $composed().spliceText(1, 0, 'R');
            $setSelection(null);
          });
          await t.sync();
          expect(text(a)).toBe('x|abc');
          a.warnings.length = 0;
          const endangers = Writer.prototype.$endangersHeld;
          Writer.prototype.$endangersHeld = function (this: Writer) {
            endangers.call(this);
            return false;
          };
          onTestFinished(() => {
            Writer.prototype.$endangersHeld = endangers;
          });
          const errors = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});
          onTestFinished(() => errors.mockRestore());
          // The Yjs updates A's update emits: a write the guard stopped part
          // way is finished in its own transaction, so peers get one update,
          // never what the stopped write left (a copy one could type into).
          let updates = 0;
          const count = (
            _u: Uint8Array,
            _o: unknown,
            _d: unknown,
            tr: {local: boolean},
          ) => {
            if (tr.local) {
              updates++;
            }
          };
          a.doc.on('update', count);
          if (kind === 'container moved, a fault after its copy') {
            const fill = Writer.prototype.$fillNode;
            let armed = true;
            Writer.prototype.$fillNode = function (
              this: Writer,
              ...args: Parameters<Writer['$fillNode']>
            ) {
              fill.apply(this, args);
              if (armed && this.tr.doc === a.doc) {
                armed = false;
                throw new Error('fault after a copy');
              }
            };
            onTestFinished(() => {
              Writer.prototype.$fillNode = fill;
            });
          }
          a.update(() => {
            if (kind === 'container moved, a fault after its copy') {
              const box = $composed().getParentOrThrow();
              ($getRoot().getFirstChildOrThrow() as ElementNode).append(box);
            } else if (kind === 'moved first, container moved') {
              const box = $composed().getParentOrThrow();
              const p1 = $getRoot().getFirstChildOrThrow() as ElementNode;
              const x = p1.getFirstChildOrThrow();
              ($getRoot().getLastChildOrThrow() as ElementNode).append(x);
              p1.append(box);
            } else if (kind === 'moved first') {
              const x = (
                $getRoot().getFirstChildOrThrow() as ElementNode
              ).getFirstChildOrThrow();
              ($getRoot().getLastChildOrThrow() as ElementNode).append(x);
            } else if (kind !== 'none') {
              (
                (
                  $getRoot().getFirstChildOrThrow() as ElementNode
                ).getFirstChildOrThrow() as TextNode
              ).setTextContent(typed ? 'xZ' : '');
            }
            if (
              kind !== 'moved first, container moved' &&
              kind !== 'container moved, a fault after its copy'
            ) {
              $composed().getParentOrThrow().remove();
            }
          });
          a.doc.off('update', count);
          // (None where it was stopped before it changed anything.)
          expect(updates).toBeLessThan(2);
          await t.sync();
          Writer.prototype.$endangersHeld = endangers;
          const reported = errors.mock.calls.some(c =>
            String(c[0]).includes('which its check did not foresee'),
          );
          if (kind !== 'none' && kind !== 'typed') {
            // Stopped (or failing) after it changed something: recovered in
            // the same transaction, decided as the update was (inserting
            // nothing): what the hold keeps stays, and the editor reads the
            // document again.
            expect(
              a.warnings.some(w =>
                /a local change could not be written/.test(w),
              ),
            ).toBe(true);
          } else if (typed) {
            // Never stopped: the typing is written. The decision foresaw
            // the delete (the update removes the container) and allowed it,
            // so nothing is reported.
            expect(reported).toBe(false);
            expect(
              a.warnings.some(w => /would delete or leave behind/.test(w)),
            ).toBe(false);
          } else {
            // Stopped before the delete, and refused as a held change.
            expect(reported).toBe(false);
            expect(
              a.warnings.some(w => /would delete or leave behind/.test(w)),
            ).toBe(true);
          }
          a.warnings.length = 0;
          a.update(() => $setCompositionKey(null));
          await t.sync();
          const fresh = await freshReader(a);
          onTestFinished(() => fresh.stop());
          const stored = text(fresh);
          if (kind !== 'none' && kind !== 'typed') {
            expect(stored).toBe(text(a));
            expect(stored.split('aRbc')).toHaveLength(2);
            expect(stored.split('x')).toHaveLength(
              kind === 'deleted first' ? 1 : 2,
            );
          } else if (typed) {
            expect(stored).toContain('xZ');
          } else {
            expect(stored).toBe('x|aRbc');
          }
          for (const p of t.peers) {
            expect(text(p)).toBe(stored);
            expect(JSON.stringify(p.json())).toBe(JSON.stringify(fresh.json()));
          }
        });
      }
    }
  }
});

describe('the recovery of a write the guard stopped part way, in skip mode, with a slot value replaced', () => {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      for (const op of [
        'replace',
        'move out',
        'rename',
        'edit and move out',
        'swap',
      ] as const) {
        test(`${op === 'replace' ? 'the replacement of the slot value holding the container is skipped, never filled or mapped' : op === 'move out' ? 'the container moved out of the slot value into another stored node is left where it is stored, never copied there' : op === 'swap' ? 'the slot values swapped, the one holding the container second: the copy the stopped write made under the first name is deleted, the value kept where it is stored' : op === 'edit and move out' ? 'the container, with a deletion inside it, moved out of the slot value into another stored node: no copy left, every character once (the deletion inside it undone)' : 'the slot value holding the container moved to another, occupied slot of its host is left where it is stored, never copied'}: every peer converges, R kept once (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
          const t = await setup(
            () =>
              $getRoot().append(
                $createParagraphNode().append(
                  $create(TextNode).setTextContent('x'),
                ),
                $setSlot(
                  $create(Host),
                  'title',
                  $createParagraphNode().append(
                    $create(Box).append(
                      $create(TextNode).setTextContent('abc'),
                    ),
                  ),
                ),
              ),
            {gc, ids, nodes: [...NODES, Box, Host]},
          );
          const {a, b} = t;
          const dom = document.createElement('div');
          dom.contentEditable = 'true';
          document.body.append(dom);
          a.editor.setRootElement(dom);
          onTestFinished(() => {
            a.editor.setRootElement(null);
            dom.remove();
            t.peers.forEach(p => p.stop());
          });
          if (op === 'rename' || op === 'swap') {
            a.update(() =>
              $setSlot(
                $getRoot().getLastChildOrThrow() as Host,
                'other',
                $createParagraphNode().append(
                  $create(TextNode).setTextContent('occupied'),
                ),
              ),
            );
            await t.sync();
          }
          const $boxText = () =>
            $getRoot()
              .getAllTextNodes()
              .find(n => n.getParent() instanceof Box) as TextNode;
          a.update(() => {
            const n = $boxText();
            n.select(1, 1);
            $setCompositionKey(n.getKey());
          });
          await t.sync();
          b.update(() => {
            $boxText().spliceText(1, 0, 'R');
            $setSelection(null);
          });
          await t.sync();
          a.warnings.length = 0;
          const endangers = Writer.prototype.$endangersHeld;
          Writer.prototype.$endangersHeld = function (this: Writer) {
            endangers.call(this);
            return false;
          };
          onTestFinished(() => {
            Writer.prototype.$endangersHeld = endangers;
          });
          const errors = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});
          onTestFinished(() => errors.mockRestore());
          let updates = 0;
          const count = (
            _u: Uint8Array,
            _o: unknown,
            _d: unknown,
            tr: {local: boolean},
          ) => {
            if (tr.local) {
              updates++;
            }
          };
          a.doc.on('update', count);
          a.update(() => {
            $setSelection(null);
            (
              (
                $getRoot().getFirstChildOrThrow() as ElementNode
              ).getFirstChildOrThrow() as TextNode
            ).setTextContent('');
            const host = $getRoot().getLastChildOrThrow() as Host;
            const old = $getSlot(host, 'title') as ParagraphNode;
            if (op === 'replace') {
              $setSlot(
                host,
                'title',
                $createParagraphNode().append(
                  $create(Box).append(
                    $create(TextNode).setTextContent(old.getTextContent()),
                  ),
                ),
              );
            } else if (op === 'swap') {
              // Both values swapped: no slot name removed, so a copy of the
              // container's value can be written under the first name before
              // the second's replacement stops the write.
              const other = $getSlot(host, 'other') as ParagraphNode;
              $removeSlot(host, 'title');
              $removeSlot(host, 'other');
              $setSlot(host, 'title', other);
              $setSlot(host, 'other', old);
            } else if (op === 'edit and move out') {
              // A deletion inside the container, then the container moved to
              // another stored node: the stopped write may already have
              // written its copy there (deleted again, the original kept).
              $boxText().spliceText(1, 2, '');
              ($getRoot().getFirstChildOrThrow() as ElementNode).append(
                $boxText().getParentOrThrow(),
              );
            } else if (op === 'move out') {
              ($getRoot().getFirstChildOrThrow() as ElementNode).append(
                $boxText().getParentOrThrow(),
              );
            } else {
              $removeSlot(host, 'title');
              $setSlot(host, 'other', old);
            }
          });
          a.doc.off('update', count);
          // One update at most: no peer ever gets what the stopped write
          // left (a copy one could type into).
          expect(updates).toBeLessThan(2);
          await t.sync();
          Writer.prototype.$endangersHeld = endangers;
          a.warnings.length = 0;
          a.update(() => $setCompositionKey(null));
          await t.sync();
          const fresh = await freshReader(a);
          onTestFinished(() => fresh.stop());
          const stored = text(fresh);
          expect(stored.split('R')).toHaveLength(2);
          expect(stored.split('abc').length + stored.split('aRbc').length).toBe(
            3,
          );
          for (const p of t.peers) {
            expect(text(p)).toBe(stored);
            expect(JSON.stringify(p.json())).toBe(JSON.stringify(fresh.json()));
          }
          expect(a.errors).toEqual([]);
        });
      }
    }
  }
});
