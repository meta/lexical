/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A composes `abc` in an inline container (sequence) or in a slot's
// paragraph (map); B types R in it, held. A then merges the composed text
// into another text node whose own `abc` it emptied, so that node's final
// text is `abc` as before: in a sequence, unwrapping the container; in a
// map, moving the text into another paragraph that becomes the slot's new
// value. Equal final text proves no removal: the edit is refused before it
// writes anything, and R stays once on every peer and a fresh reader. The
// same when the edit is an app's selectionTransform inside a remote read.

import {$createListItemNode, $createListNode} from '@lexical/list';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
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
  ParagraphNode,
  TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

import {freshReader, NODES, setup} from '../../utils/harness';

class Box extends ElementNode {
  $config() {
    return this.config('merge_box', {children: 'inline', extends: ElementNode});
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
    return this.config('merge_host', {
      extends: ParagraphNode,
      slots: ['title'],
    });
  }
}

/** A reaction an app runs once, from a selection transform in a read. */
const reactions = new WeakMap<LexicalEditor, () => void>();

class Hook extends TextNode {
  $config() {
    return this.config('merge_hook', {extends: TextNode});
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

describe('a merge into a text node whose final text is unchanged, under a hold', () => {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      for (const path of ['sequence', 'map'] as const) {
        for (const mode of ['local', 'read-edit'] as const) {
          test(`the merge (${path}, ${mode}) is refused, and R stays once (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
            const t = await setup(
              () => {
                if (path === 'sequence') {
                  $getRoot().append(
                    $createListNode('number').append(
                      $createListItemNode().append(
                        $create(Hook).setTextContent('abc'),
                        $create(Box).append(
                          $create(Hook).setTextContent('abc'),
                        ),
                      ),
                      $createListItemNode().append($createTextNode('tail')),
                    ),
                  );
                } else {
                  $getRoot().append(
                    $setSlot(
                      $create(Host),
                      'title',
                      $createParagraphNode().append(
                        $create(Hook).setTextContent('abc'),
                      ),
                    ),
                    $createParagraphNode().append(
                      $create(Hook).setTextContent('abc'),
                    ),
                  );
                }
                $getRoot().append(
                  $createParagraphNode().append($createTextNode('separator')),
                );
              },
              {gc, ids, nodes: [...NODES, Box, Host, Hook]},
            );
            const {a, b, c} = t;
            const dom = document.createElement('div');
            dom.contentEditable = 'true';
            document.body.append(dom);
            a.editor.setRootElement(dom);
            dom.focus();
            onTestFinished(() => {
              a.editor.setRootElement(null);
              dom.remove();
              t.peers.forEach(p => p.stop());
            });
            a.warnings.length = 0;
            const $source = (): TextNode => {
              if (path === 'sequence') {
                const item = (
                  $getRoot().getFirstChildOrThrow() as ElementNode
                ).getFirstChildOrThrow() as ElementNode;
                const box = item.getChildren()[1] as ElementNode;
                return box.getFirstChildOrThrow() as TextNode;
              }
              const host = $getRoot().getFirstChildOrThrow() as Host;
              const slot = $getSlot(host, 'title') as ParagraphNode;
              return slot.getFirstChildOrThrow() as TextNode;
            };
            a.update(() => {
              const n = $source();
              n.select(1, 1);
              $setCompositionKey(n.getKey());
            });
            await t.sync();
            b.update(() => {
              $source().spliceText(1, 0, 'R');
              $setSelection(null);
            });
            await t.sync();
            const $merge = () => {
              const n = $source();
              if (path === 'sequence') {
                const box = n.getParentOrThrow();
                const prefix = box.getPreviousSibling() as TextNode;
                box.insertBefore(n);
                box.remove();
                prefix.getLatest().spliceText(0, 3, '');
                prefix.getLatest().mergeWithSibling(n.getLatest());
              } else {
                const host = $getRoot().getFirstChildOrThrow() as Host;
                const target = $getRoot().getChildren()[1] as ParagraphNode;
                const prefix = target.getFirstChildOrThrow() as TextNode;
                target.append(n);
                prefix.getLatest().spliceText(0, 3, '');
                prefix.getLatest().mergeWithSibling(n.getLatest());
                target.remove();
                $setSlot(host, 'title', target);
              }
            };
            if (mode === 'local') {
              a.update($merge);
            } else {
              reactions.set(a.editor, $merge);
              c.update(() => {
                (
                  (
                    $getRoot().getLastChildOrThrow() as ElementNode
                  ).getFirstChildOrThrow() as TextNode
                ).spliceText(9, 0, '!');
                $setSelection(null);
              });
            }
            await t.sync();
            expect(a.warnings).toHaveLength(1);
            expect(a.warnings[0]).toMatch(
              /would delete or leave behind text a collaborator wrote/,
            );
            a.warnings.length = 0;
            a.update(() => $setCompositionKey(null));
            await t.sync();
            const fresh = await freshReader(a);
            onTestFinished(() => fresh.stop());
            const values = [...t.peers, fresh].map(p =>
              p.read(() =>
                $getRoot()
                  .getAllTextNodes()
                  .map(n => n.getTextContent())
                  .join('|'),
              ),
            );
            for (const value of values) {
              expect(value).toBe(values[0]);
            }
            expect(values[0].split('R')).toHaveLength(2);
            expect(a.warnings).toEqual([]);
          });
        }
      }
    }
  }
});

describe("a slot's paragraph replaced by a new one with the same text, under a hold", () => {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      test(`the replacement is refused, and R stays once (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $setSlot(
                $create(Host),
                'title',
                $createParagraphNode().append($createTextNode('abc')),
              ),
            ),
          {gc, ids, nodes: [...NODES, Box, Host, Hook]},
        );
        const {a, b} = t;
        const dom = document.createElement('div');
        dom.contentEditable = 'true';
        document.body.append(dom);
        a.editor.setRootElement(dom);
        dom.focus();
        onTestFinished(() => {
          a.editor.setRootElement(null);
          dom.remove();
          t.peers.forEach(p => p.stop());
        });
        a.warnings.length = 0;
        const $first = () => $getRoot().getAllTextNodes()[0];
        a.update(() => {
          const n = $first();
          n.select(1, 1);
          $setCompositionKey(n.getKey());
        });
        await t.sync();
        b.update(() => {
          $first().spliceText(1, 0, 'R');
          $setSelection(null);
        });
        await t.sync();
        // A new paragraph with a new text node of the text A sees, which A
        // composes in from then on.
        a.update(() => {
          const host = $getRoot().getFirstChildOrThrow() as Host;
          const old = $getSlot(host, 'title') as ParagraphNode;
          const replacement = $createTextNode(old.getTextContent());
          $setSlot(host, 'title', $createParagraphNode().append(replacement));
          replacement.select(1, 1);
          $setCompositionKey(replacement.getKey());
        });
        await t.sync();
        expect(a.warnings).toHaveLength(1);
        a.warnings.length = 0;
        a.update(() => $setCompositionKey(null));
        await t.sync();
        const fresh = await freshReader(a);
        onTestFinished(() => fresh.stop());
        const values = [...t.peers, fresh].map(p =>
          p.read(() =>
            $getRoot()
              .getAllTextNodes()
              .map(n => n.getTextContent())
              .join('|'),
          ),
        );
        for (const value of values) {
          expect(value).toBe(values[0]);
        }
        expect(values[0].split('R')).toHaveLength(2);
        expect(a.warnings).toEqual([]);
      });
    }
  }
});
