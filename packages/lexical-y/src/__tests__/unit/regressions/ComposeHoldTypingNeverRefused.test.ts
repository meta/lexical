/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A composer's hold refuses a local update that would delete or write anew
// the shared node that holds a collaborator's held change, only where the
// update inserts no character (see $heldDecision): refusing it reads the
// document again, undoing the whole update, which must never undo a typed
// character. Each update here moves the item A composes in (which, written,
// would delete the inline container holding B's held R) together with a
// change of text: refused where the change only deletes, moves or re-keys
// text (R kept); written as made where it inserts a character (every typed
// character kept, R going with the old container as main writes it).

import {$createLinkNode} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  type ListNode,
} from '@lexical/list';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $getDocument,
  $getEditor,
  $getRoot,
  $getSlot,
  $hasUpdateTag,
  $setCompositionKey,
  $setSelection,
  $setSlot,
  COLLABORATION_TAG,
  ElementNode,
  type LexicalEditor,
  type LexicalNode,
  ParagraphNode,
  TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

import {freshReader, NODES, type Peer, setup} from '../../utils/harness';

class Box extends ElementNode {
  $config() {
    return this.config('typing_box', {
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

/** A reaction an app runs once, from a selection transform in a read. */
const reactions = new WeakMap<LexicalEditor, () => void>();

/** Composed text whose selection transform runs an app's reaction. */
class Hook extends TextNode {
  $config() {
    return this.config('typing_hook', {extends: TextNode});
  }
  selectionTransform() {
    const editor = $getEditor();
    const reaction = reactions.get(editor);
    if (reaction !== undefined && $hasUpdateTag(COLLABORATION_TAG)) {
      reactions.delete(editor);
      reaction();
    }
  }
}

class Host extends ParagraphNode {
  $config() {
    return this.config('typing_host', {
      extends: ParagraphNode,
      slots: ['title'],
    });
  }
}

const allText = (p: Peer) =>
  p.read(() =>
    $getRoot()
      .getAllTextNodes()
      .map(n => n.getTextContent())
      .join('|'),
  );

const $text = (format: number, text: string) =>
  $create(TextNode).setTextContent(text).setFormat(format);

/** The composed text: the text node in a Box. */
const $composed = (): TextNode =>
  $getRoot()
    .getAllTextNodes()
    .find(n => n.getParent() instanceof Box) as TextNode;

/** Moves the list item holding the Box to the end of its list. */
const $moveItem = () => {
  const item = $composed().getParentOrThrow().getParentOrThrow();
  (item.getParentOrThrow() as ListNode).append(item);
};

async function start(
  $init: () => void,
  gc: boolean,
  ids: number[],
  $held: () => void = () => $composed().spliceText(1, 0, 'R'),
) {
  const t = await setup($init, {gc, ids, nodes: [...NODES, Box, Host, Hook]});
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
    $held();
    $setSelection(null);
  });
  await t.sync();
  a.warnings.length = 0;
  return t;
}

async function settle(t: Awaited<ReturnType<typeof start>>) {
  t.a.update(() => $setCompositionKey(null));
  await t.sync();
  const fresh = await freshReader(t.a);
  onTestFinished(() => fresh.stop());
  for (const p of t.peers) {
    expect(allText(p)).toBe(allText(fresh));
  }
  return allText(fresh);
}

const REFUSAL = /would delete or leave behind text a collaborator wrote/;

/** A list: the item A composes in (`$box`), then a paragraph `$rest`. */
const $doc =
  (rest: () => LexicalNode[], box = 'abc') =>
  () =>
    $getRoot().append(
      $createListNode('number').append(
        $createListItemNode().append($create(Box).append($text(0, box))),
        $createListItemNode().append($text(0, 'tail')),
      ),
      $createParagraphNode().append(...rest()),
    );

describe('a refusal under a hold never undoes a typed character', () => {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      const id = `(gc ${gc ? 'on' : 'off'}, ids ${ids})`;
      test(`a character typed into one node while another node's equal character is deleted, with the move: written, the typed character kept ${id}`, async () => {
        // L | x | y | x (each its own format): S gets the removed x, the
        // typed x goes before y, U's x is deleted. Both x's are not one.
        const t = await start(
          $doc(() => [
            $text(1, 'L'),
            $text(2, 'x'),
            $text(0, 'y'),
            $text(8, 'x'),
          ]),
          gc,
          ids,
        );
        t.a.update(() => {
          const [s, x, y, u] = (
            $getRoot().getLastChildOrThrow() as ElementNode
          ).getChildren() as TextNode[];
          s.setTextContent('Lx');
          x.remove();
          y.setTextContent('xy');
          u.setTextContent('');
          $moveItem();
        });
        await t.sync();
        expect(t.a.warnings).toEqual([]);
        const text = await settle(t);
        expect(text).toContain('Lx');
        expect(text).toContain('xy');
      });
      for (const side of ['before', 'after'] as const) {
        test(`an unwrap whose text Lexical merges into the text ${side} it is refused, and R kept ${id}`, async () => {
          const t = await start(
            () =>
              $getRoot().append(
                $createListNode('number').append(
                  $createListItemNode().append(
                    ...(side === 'before'
                      ? [$text(0, 'x'), $create(Box).append($text(0, 'abc'))]
                      : [$create(Box).append($text(0, 'abc')), $text(0, 'y')]),
                  ),
                  $createListItemNode().append($text(0, 'tail')),
                ),
              ),
            gc,
            ids,
          );
          t.a.update(() => {
            const box = $composed().getParentOrThrow();
            for (const child of box.getChildren()) {
              box.insertBefore(child);
            }
            box.remove();
          });
          await t.sync();
          expect(t.a.warnings).toHaveLength(1);
          expect(t.a.warnings[0]).toMatch(REFUSAL);
          t.a.warnings.length = 0;
          expect((await settle(t)).split('R')).toHaveLength(2);
        });
      }
      test(`an autocorrect that reorders the composed text (teh to the), with the move: written, the typing kept ${id}`, async () => {
        const t = await start(
          $doc(() => [$text(0, 'after')], 'teh'),
          gc,
          ids,
        );
        t.a.update(() => {
          $composed().setTextContent('the');
          $moveItem();
        });
        await t.sync();
        expect(t.a.warnings).toEqual([]);
        expect(await settle(t)).toContain('the');
      });
      test(`a character outside the BMP made from the surrogates of two others is typed: written, kept ${id}`, async () => {
        // 😀🤣 (D83D DE00 D83E DD23) to 🔣 (D83D DD23): by UTF-16 code
        // units a subsequence, by code points a new character.
        const t = await start(
          $doc(() => [$text(0, '😀🤣')]),
          gc,
          ids,
        );
        t.a.update(() => {
          (
            (
              $getRoot().getLastChildOrThrow() as ElementNode
            ).getFirstChildOrThrow() as TextNode
          ).setTextContent('🔣');
          $moveItem();
        });
        await t.sync();
        expect(t.a.warnings).toEqual([]);
        expect(await settle(t)).toContain('🔣');
      });
      test(`a block cut and pasted with the move (same text, new keys): refused, and R kept ${id}`, async () => {
        const t = await start(
          $doc(() => [$text(0, 'after')]),
          gc,
          ids,
        );
        t.a.update(() => {
          const p = $getRoot().getLastChildOrThrow() as ElementNode;
          const copy = $createParagraphNode().append($text(0, 'after'));
          p.remove();
          $getRoot().getFirstChildOrThrow().insertBefore(copy);
          $moveItem();
        });
        await t.sync();
        expect(t.a.warnings).toHaveLength(1);
        t.a.warnings.length = 0;
        expect((await settle(t)).split('R')).toHaveLength(2);
      });
      test(`a block cut and pasted with one character typed in it, with the move: written, the typing kept ${id}`, async () => {
        const t = await start(
          $doc(() => [$text(0, 'after')]),
          gc,
          ids,
        );
        t.a.update(() => {
          const p = $getRoot().getLastChildOrThrow() as ElementNode;
          const copy = $createParagraphNode().append($text(0, 'afterQ'));
          p.remove();
          $getRoot().getFirstChildOrThrow().insertBefore(copy);
          $moveItem();
        });
        await t.sync();
        expect(t.a.warnings).toEqual([]);
        expect(await settle(t)).toContain('afterQ');
      });
      for (const typed of [false, true]) {
        test(`a slot's paragraph replaced by new nodes of the same text${typed ? ' and one typed character' : ''}: ${typed ? 'written, the typing kept' : 'refused, and R kept'} ${id}`, async () => {
          const t = await start(
            () =>
              $getRoot().append(
                $setSlot(
                  $create(Host),
                  'title',
                  $createParagraphNode().append(
                    $create(Box).append($text(0, 'abc')),
                  ),
                ),
              ),
            gc,
            ids,
          );
          t.a.update(() => {
            // (The composed text goes: no selection is left in it.)
            $setSelection(null);
            const host = $getRoot().getFirstChildOrThrow() as Host;
            const old = $getSlot(host, 'title') as ParagraphNode;
            const text = old.getTextContent() + (typed ? 'Q' : '');
            $setSlot(
              host,
              'title',
              $createParagraphNode().append(
                $create(Box).append($text(0, text)),
              ),
            );
          });
          await t.sync();
          if (typed) {
            expect(t.a.warnings).toEqual([]);
            expect(await settle(t)).toContain('abcQ');
          } else {
            expect(t.a.warnings).toHaveLength(1);
            t.a.warnings.length = 0;
            expect((await settle(t)).split('R')).toHaveLength(2);
          }
        });
      }
      test(`a collaborator's replacement of a character in the composed text is read at once, not held (only format deletions are kept back, see Hidden#keep): A's whole replacement typed with the move is written, the typed character kept ${id}`, async () => {
        const t = await start(
          $doc(() => [$text(0, 'after')]),
          gc,
          ids,
          () => $composed().spliceText(1, 1, 'R'),
        );
        expect(t.a.read(() => $composed().getTextContent())).toBe('aRc');
        t.a.update(() => {
          $composed().setTextContent('b');
          $moveItem();
        });
        await t.sync();
        expect(t.a.warnings).toEqual([]);
        expect(await settle(t)).toContain('b');
      });
      test(`A's identical replacement of a character of the composed text (b for b), with the move, while B's deletion of that character is applied inside the update (its read deferred): written, the typed character kept ${id}`, async () => {
        const t = await start(
          $doc(() => [$text(0, 'after')]),
          gc,
          ids,
        );
        t.b.online = false;
        t.b.update(() => {
          const n = $composed();
          n.spliceText(n.getTextContent().indexOf('b'), 1, '');
          $setSelection(null);
        });
        const list = t.a.pending.get(t.b)!;
        t.a.pending.delete(t.b);
        const update = Y.mergeUpdates(list as Uint8Array<ArrayBuffer>[]);
        t.a.update(() => {
          Y.applyUpdate(t.a.doc, update, t.a.net);
          $composed().spliceText(1, 1, 'b');
          $moveItem();
        });
        await t.sync();
        expect(t.a.warnings.filter(w => REFUSAL.test(w))).toEqual([]);
        t.a.warnings.length = 0;
        expect(await settle(t)).toMatch(/b/);
      });
      test(`A splits the composed text, sets its tail's first character again (b for b), merges it back, with the move, while B's deletion of that character is applied inside the update: written, the typed character kept ${id}`, async () => {
        const t = await start(
          $doc(() => [$text(0, 'after')]),
          gc,
          ids,
        );
        t.b.online = false;
        t.b.update(() => {
          const n = $composed();
          n.spliceText(n.getTextContent().indexOf('b'), 1, '');
          $setSelection(null);
        });
        const list = t.a.pending.get(t.b)!;
        t.a.pending.delete(t.b);
        const update = Y.mergeUpdates(list as Uint8Array<ArrayBuffer>[]);
        t.a.update(() => {
          Y.applyUpdate(t.a.doc, update, t.a.net);
          const [head, tail] = $composed().splitText(1);
          tail.spliceText(0, 1, 'b');
          head.mergeWithSibling(tail);
          $moveItem();
        });
        await t.sync();
        expect(t.a.warnings.filter(w => REFUSAL.test(w))).toEqual([]);
        t.a.warnings.length = 0;
        expect(await settle(t)).toMatch(/b/);
      });
      test(`the same split 65 levels deep (a split of each split-off tail), the character set again in the deepest: written, the typed character kept ${id}`, async () => {
        const depth = 65;
        const t = await start(
          $doc(() => [$text(0, 'after')], 'a'.repeat(depth) + 'bc'),
          gc,
          ids,
        );
        t.b.online = false;
        t.b.update(() => {
          const n = $composed();
          n.spliceText(n.getTextContent().indexOf('b'), 1, '');
          $setSelection(null);
        });
        const list = t.a.pending.get(t.b)!;
        t.a.pending.delete(t.b);
        const update = Y.mergeUpdates(list as Uint8Array<ArrayBuffer>[]);
        t.a.update(() => {
          Y.applyUpdate(t.a.doc, update, t.a.net);
          const parts: TextNode[] = [$composed()];
          for (let i = 0; i < depth; i++) {
            const [, tail] = parts[parts.length - 1].splitText(1);
            parts.push(tail);
          }
          parts[parts.length - 1].spliceText(0, 1, 'b');
          for (let i = parts.length - 1; i > 0; i--) {
            parts[i - 1].getLatest().mergeWithSibling(parts[i].getLatest());
          }
          $moveItem();
        });
        await t.sync();
        expect(t.a.warnings.filter(w => REFUSAL.test(w))).toEqual([]);
        t.a.warnings.length = 0;
        expect(await settle(t)).toMatch(/b/);
      });
      for (const deferred of [false, true]) {
        test(`A's whole replacement of the composed text by one of its characters, with the move${deferred ? ", while B's deletion of that character is applied inside the update (its read deferred): written, the typed character kept" : ': refused, and R kept'} ${id}`, async () => {
          const t = await start(
            $doc(() => [$text(0, 'after')]),
            gc,
            ids,
          );
          let update: Uint8Array | null = null;
          if (deferred) {
            t.b.online = false;
            t.b.update(() => {
              const n = $composed();
              const at = n.getTextContent().indexOf('b');
              n.spliceText(at, 1, '');
              $setSelection(null);
            });
            const list = t.a.pending.get(t.b)!;
            t.a.pending.delete(t.b);
            update = Y.mergeUpdates(list as Uint8Array<ArrayBuffer>[]);
          }
          t.a.update(() => {
            if (update !== null) {
              Y.applyUpdate(t.a.doc, update, t.a.net);
            }
            $composed().setTextContent('b');
            $moveItem();
          });
          await t.sync();
          const text = deferred ? null : t.a.warnings.length;
          if (deferred) {
            expect(t.a.warnings.filter(w => REFUSAL.test(w))).toEqual([]);
            t.a.warnings.length = 0;
            expect(await settle(t)).toContain('b');
          } else {
            expect(text).toBe(1);
            t.a.warnings.length = 0;
            expect((await settle(t)).split('R')).toHaveLength(2);
          }
        });
      }
      test(`as an app's edit inside a remote read: A's whole replacement of the composed text by one of its characters, with the move, while B's deletion of that character is applied inside the update (its read deferred): written, the typed character kept ${id}`, async () => {
        const t = await start(
          () =>
            $getRoot().append(
              $createListNode('number').append(
                $createListItemNode().append(
                  $create(Box).append($create(Hook).setTextContent('abc')),
                ),
                $createListItemNode().append($text(0, 'tail')),
              ),
              $createParagraphNode().append($text(0, 'after')),
            ),
          gc,
          ids,
        );
        t.b.online = false;
        t.b.update(() => {
          const n = $composed();
          n.spliceText(n.getTextContent().indexOf('b'), 1, '');
          $setSelection(null);
        });
        const list = t.a.pending.get(t.b)!;
        t.a.pending.delete(t.b);
        const update = Y.mergeUpdates(list as Uint8Array<ArrayBuffer>[]);
        reactions.set(t.a.editor, () => {
          Y.applyUpdate(t.a.doc, update, t.a.net);
          $composed().setTextContent('b');
          $moveItem();
        });
        t.c.update(() => {
          const after = $getRoot()
            .getAllTextNodes()
            .find(n => n.getTextContent() === 'after')!;
          after.spliceText(5, 0, '!');
          $setSelection(null);
        });
        await t.sync();
        expect(t.a.warnings.filter(w => REFUSAL.test(w))).toEqual([]);
        t.a.warnings.length = 0;
        expect(await settle(t)).toContain('b');
      });
      test(`the container composed in moved to a new line (written, R kept), then joined back into its old line (refused, R kept) ${id}`, async () => {
        const t = await start(
          $doc(() => [$text(0, 'after')]),
          gc,
          ids,
        );
        t.a.update(() => {
          const box = $composed().getParentOrThrow();
          box.getParentOrThrow().insertAfter($createListItemNode().append(box));
        });
        await t.sync();
        expect(t.a.warnings).toEqual([]);
        t.a.update(() => {
          const box = $composed().getParentOrThrow();
          const line = box.getParentOrThrow();
          (line.getPreviousSibling() as ElementNode).append(box);
          line.remove();
        });
        await t.sync();
        expect(t.a.warnings).toHaveLength(1);
        expect(t.a.warnings[0]).toMatch(REFUSAL);
        t.a.warnings.length = 0;
        expect((await settle(t)).split('R')).toHaveLength(2);
      });
      test(`the container composed in moved away so that the text on both sides of it merges, no character typed: refused, and R kept ${id}`, async () => {
        const t = await start(
          () =>
            $getRoot().append(
              $createParagraphNode().append(
                $text(0, 'left'),
                $create(Box).append($text(0, 'abc')),
                $text(0, 'right'),
              ),
              $createParagraphNode().append($text(0, 'destination')),
            ),
          gc,
          ids,
        );
        t.a.update(() => {
          const box = $composed().getParentOrThrow();
          ($getRoot().getLastChildOrThrow() as ElementNode).append(box);
        });
        await t.sync();
        expect(t.a.warnings).toHaveLength(1);
        expect(t.a.warnings[0]).toMatch(REFUSAL);
        t.a.warnings.length = 0;
        const text = await settle(t);
        expect(text.split('R')).toHaveLength(2);
        expect(text).toContain('left|aRbc|right');
      });
      for (const remote of ['deletes', 'types'] as const) {
        test(`a move that types nothing, refused while B's change that ${remote === 'deletes' ? 'deletes text' : 'types S'} elsewhere is applied inside the update (its read deferred): B's change read exactly once, R kept ${id}`, async () => {
          const t = await start(
            $doc(() => [$text(0, 'after')]),
            gc,
            ids,
          );
          t.b.online = false;
          t.b.update(() => {
            const after = $getRoot()
              .getAllTextNodes()
              .find(n => n.getTextContent() === 'after')!;
            if (remote === 'deletes') {
              after.spliceText(0, 2, '');
            } else {
              after.spliceText(5, 0, 'S');
            }
            $setSelection(null);
          });
          const list = t.a.pending.get(t.b)!;
          t.a.pending.delete(t.b);
          const update = Y.mergeUpdates(list as Uint8Array<ArrayBuffer>[]);
          t.a.update(() => {
            Y.applyUpdate(t.a.doc, update, t.a.net);
            $moveItem();
          });
          await t.sync();
          expect(t.a.warnings).toHaveLength(1);
          expect(t.a.warnings[0]).toMatch(REFUSAL);
          t.a.warnings.length = 0;
          const text = await settle(t);
          expect(text.split('R')).toHaveLength(2);
          expect(text).toContain(remote === 'deletes' ? '|ter' : '|afterS');
          expect(text.split('S')).toHaveLength(remote === 'deletes' ? 1 : 2);
        });
      }
      const $moveTextOut = () => {
        const box = $composed().getParentOrThrow();
        const dest = $getRoot()
          .getAllTextNodes()
          .find(n => n.getTextContent() === 'dest')!;
        dest.insertAfter($composed());
        box.remove();
      };
      const $twoLines = () =>
        $getRoot().append(
          $createParagraphNode().append(
            $text(0, 'left'),
            $create(Box).append($text(0, 'abc')),
            $text(0, 'right'),
          ),
          $createParagraphNode().append($text(0, 'dest')),
        );
      test(`the composed text moved out of its container into another line, where it merges, the container removed: refused (the merge is recorded), and R kept ${id}`, async () => {
        const t = await start($twoLines, gc, ids);
        t.a.update($moveTextOut);
        await t.sync();
        expect(t.a.warnings).toHaveLength(1);
        expect(t.a.warnings[0]).toMatch(REFUSAL);
        t.a.warnings.length = 0;
        expect((await settle(t)).split('R')).toHaveLength(2);
      });
      test(`the container composed in removed while the same characters are typed at the end of another line (no merge recorded): written, the typing kept ${id}`, async () => {
        const t = await start($twoLines, gc, ids);
        t.a.update(() => {
          const box = $composed().getParentOrThrow();
          const dest = $getRoot()
            .getAllTextNodes()
            .find(n => n.getTextContent() === 'dest')!;
          dest.setTextContent('destabc');
          box.remove();
        });
        await t.sync();
        expect(t.a.warnings.filter(w => REFUSAL.test(w))).toEqual([]);
        t.a.warnings.length = 0;
        expect(await settle(t)).toContain('destabc');
      });
      test(`two structural changes in one update: the container composed in moved to a new line, inside a new link, the text around where it was merging; no character typed: R kept (the writer keeps the container, or the update is refused) ${id}`, async () => {
        const t = await start($twoLines, gc, ids);
        t.a.update(() => {
          const box = $composed().getParentOrThrow();
          const line = box.getParentOrThrow();
          const p = $createParagraphNode();
          line.insertAfter(p);
          const wrap = $createLinkNode('https://example.test');
          p.append(wrap);
          wrap.append(box);
        });
        await t.sync();
        expect(t.a.warnings.length).toBeLessThan(2);
        t.a.warnings.length = 0;
        expect((await settle(t)).split('R')).toHaveLength(2);
      });
      test(`the line holding the container composed in removed, and a text node elsewhere split, in one update: refused (the split part is the split node's own text), and R kept ${id}`, async () => {
        const t = await start($twoLines, gc, ids);
        t.a.update(() => {
          $composed().getParentOrThrow().getParentOrThrow().remove();
          $getRoot()
            .getAllTextNodes()
            .find(n => n.getTextContent() === 'dest')!
            .splitText(1);
        });
        await t.sync();
        expect(t.a.warnings).toHaveLength(1);
        expect(t.a.warnings[0]).toMatch(REFUSAL);
        t.a.warnings.length = 0;
        expect((await settle(t)).split('R')).toHaveLength(2);
      });
      test(`A types R, the character B's held change inserted, with the move: written (B's hidden R never pays for A's), A's R kept ${id}`, async () => {
        const t = await start(
          $doc(() => [$text(0, 'after')]),
          gc,
          ids,
        );
        t.a.update(() => {
          $composed().spliceText(3, 0, 'R');
          $moveItem();
        });
        await t.sync();
        expect(t.a.warnings.filter(w => REFUSAL.test(w))).toEqual([]);
        t.a.warnings.length = 0;
        expect(await settle(t)).toMatch(/abcR|aRbcR/);
      });
      test(`the text before the container emptied, the composed text merged into it, the container removed, and the merged text re-keyed, in one update: refused (the record's merge and the re-key traced), and R kept ${id}`, async () => {
        const t = await start($twoLines, gc, ids);
        t.a.update(() => {
          const composed = $composed();
          const box = composed.getParentOrThrow();
          const left = box.getPreviousSibling() as TextNode;
          left.setTextContent('');
          box.insertBefore(composed);
          box.remove();
          const merged = left
            .getLatest()
            .mergeWithSibling(composed.getLatest());
          merged.replace($text(0, merged.getTextContent()));
        });
        await t.sync();
        expect(t.a.warnings).toHaveLength(1);
        expect(t.a.warnings[0]).toMatch(REFUSAL);
        t.a.warnings.length = 0;
        expect((await settle(t)).split('R')).toHaveLength(2);
      });
      for (const kind of [
        'merged twice',
        'merged three times',
        'split twice',
        'spliced twice',
        'set twice',
      ] as const) {
        test(`a temporary text node reused in one update (${kind}) into the line after the container, the container removed: written, no character of the result lost ${id}`, async () => {
          const t = await start($twoLines, gc, ids);
          let want = '';
          t.a.update(() => {
            const box = $composed().getParentOrThrow();
            const dest = $getRoot()
              .getAllTextNodes()
              .find(n => n.getTextContent() === 'dest')!;
            const temp = $text(0, 'a');
            if (kind === 'merged twice' || kind === 'merged three times') {
              const times = kind === 'merged twice' ? 2 : 3;
              let into = dest;
              for (let i = 0; i < times; i++) {
                if (i > 0) {
                  temp.setTextContent('a');
                }
                into.getLatest().insertAfter(temp);
                into = into.getLatest().mergeWithSibling(temp.getLatest());
              }
              want = 'dest' + 'a'.repeat(times);
            } else if (kind === 'split twice') {
              dest.getLatest().insertAfter(temp.setTextContent('xyz'));
              const [, tail] = temp.getLatest().splitText(1);
              tail.getLatest().splitText(1);
              want = 'xyz';
            } else if (kind === 'spliced twice') {
              dest.getLatest().insertAfter(temp);
              temp.getLatest().spliceText(1, 0, 'b');
              temp.getLatest().spliceText(2, 0, 'c');
              want = 'abc';
            } else {
              dest.getLatest().insertAfter(temp);
              temp.getLatest().setTextContent('ab');
              temp.getLatest().setTextContent('abc');
              want = 'abc';
            }
            box.remove();
          });
          await t.sync();
          // Each inserts a character (one more `a` than the container's
          // text gives, or new letters): written, never refused.
          expect(t.a.warnings.filter(w => REFUSAL.test(w))).toEqual([]);
          t.a.warnings.length = 0;
          expect((await settle(t)).replace(/\|/g, '')).toContain(want);
        });
      }
      // The documented limit: characters removed with one node and added in
      // order to the node next to it look moved, not typed. Only app code
      // batched into a composition's update makes such an update.
      test(`documented limit: a node removed while the same characters are added next to it, with the move, is refused (the added copy goes back where it was) ${id}`, async () => {
        const t = await start(
          $doc(() => [$text(1, 'ab'), $text(0, 'cd')]),
          gc,
          ids,
        );
        t.a.update(() => {
          const [s, x] = (
            $getRoot().getLastChildOrThrow() as ElementNode
          ).getChildren() as TextNode[];
          x.remove();
          s.setTextContent('abcd');
          $moveItem();
        });
        await t.sync();
        expect(t.a.warnings).toHaveLength(1);
        t.a.warnings.length = 0;
        const text = await settle(t);
        expect(text).toContain('ab|cd');
        expect(text.split('R')).toHaveLength(2);
      });
    }
  }
});
