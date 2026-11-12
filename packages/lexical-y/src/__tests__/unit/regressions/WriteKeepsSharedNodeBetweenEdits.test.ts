/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A paragraph holds `left`, an inline container (a Box) holding `abc`, and
// `right`. B, offline, types R inside the Box. A then edits `left` and
// `right` and nothing else: the Box keeps its key, parent and place. A
// write with no record of text edits (an app's edit inside a remote read,
// see YBinding#$writeReadEdits; a recovered write) diffed the paragraph from
// its first change to its last as one rewrite, deleting the Box's shared
// node and making it again from what A shows, so B's R was lost. The Box is
// kept on every write path, and R with it.

import {
  $create,
  $createParagraphNode,
  $getDocument,
  $getEditor,
  $getRoot,
  $hasUpdateTag,
  $setSelection,
  COLLABORATION_TAG,
  ElementNode,
  type LexicalEditor,
  TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

import {Writer} from '../../../internal/Write';
import {freshReader, NODES, type Peer, setup} from '../../utils/harness';

class Box extends ElementNode {
  $config() {
    return this.config('kept_box', {children: 'inline', extends: ElementNode});
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

class Hook extends TextNode {
  $config() {
    return this.config('kept_hook', {extends: TextNode});
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

const $paragraph = () => $getRoot().getFirstChildOrThrow() as ElementNode;
const $box = () => $paragraph().getChildAtIndex(1) as Box;

const text = (p: Peer) =>
  p.read(() =>
    $getRoot()
      .getAllTextNodes()
      .map(n => n.getTextContent())
      .join('|'),
  );

describe('a write that edits the text on both sides of a shared inline node', () => {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      for (const path of ['local', 'read-edit', 'recovered'] as const) {
        test(`keeps the node and what a peer typed in it (${path}, gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
          const t = await setup(
            () =>
              $getRoot().append(
                $createParagraphNode().append(
                  $create(Hook).setTextContent('left'),
                  $create(Box).append($create(TextNode).setTextContent('abc')),
                  $create(TextNode).setTextContent('right'),
                ),
                $createParagraphNode().append(
                  $create(TextNode).setTextContent('separator'),
                ),
              ),
            {gc, ids, nodes: [...NODES, Box, Hook]},
          );
          const {a, b, c} = t;
          onTestFinished(() => t.peers.forEach(p => p.stop()));
          const boxKey = a.read(() => $box().getKey());
          const shared = () =>
            (
              a.binding as unknown as {state: {yByKey: Map<string, unknown>}}
            ).state.yByKey.get(boxKey);
          const before = shared();
          expect(before).toBeDefined();
          b.online = false;
          b.update(() => {
            ($box().getFirstChildOrThrow() as TextNode).spliceText(1, 0, 'R');
            $setSelection(null);
          });
          const $edit = () => {
            ($paragraph().getFirstChildOrThrow() as TextNode).setTextContent(
              'X',
            );
            ($paragraph().getLastChildOrThrow() as TextNode).setTextContent(
              'Y',
            );
          };
          if (path === 'read-edit') {
            a.update(() =>
              ($paragraph().getFirstChildOrThrow() as TextNode).select(1, 1),
            );
            reactions.set(a.editor, $edit);
            c.update(() => {
              const sep = (
                $getRoot().getLastChildOrThrow() as ElementNode
              ).getFirstChildOrThrow() as TextNode;
              sep.spliceText(9, 0, '!');
              $setSelection(null);
            });
          } else {
            const run = Writer.prototype.$run;
            let thrown = path !== 'recovered';
            Writer.prototype.$run = function (this: Writer) {
              if (!thrown && this.tr.doc === a.doc) {
                thrown = true;
                throw new Error(
                  'a write that fails before it changes anything',
                );
              }
              return run.call(this);
            };
            onTestFinished(() => {
              Writer.prototype.$run = run;
            });
            a.update($edit);
          }
          await t.sync();
          expect(shared()).toBe(before);
          const fresh = await freshReader(a);
          onTestFinished(() => fresh.stop());
          const want =
            path === 'read-edit' ? 'X|aRbc|Y|separator!' : 'X|aRbc|Y|separator';
          for (const p of [...t.peers, fresh]) {
            expect(text(p)).toBe(want);
          }
        });
      }
    }
  }
});

describe('a write that reorders the text around a shared inline node', () => {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      for (const path of ['local', 'read-edit'] as const) {
        test(`keeps the node and what a peer typed in it when the text nodes on both sides swap (${path}, gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
          const t = await setup(
            () =>
              $getRoot().append(
                $createParagraphNode().append(
                  $create(Hook).setTextContent('left').toggleUnmergeable(),
                  $create(Box).append($create(TextNode).setTextContent('abc')),
                  $create(TextNode).setTextContent('right').toggleUnmergeable(),
                ),
                $createParagraphNode().append(
                  $create(TextNode).setTextContent('separator'),
                ),
              ),
            {gc, ids, nodes: [...NODES, Box, Hook]},
          );
          const {a, b, c} = t;
          onTestFinished(() => t.peers.forEach(p => p.stop()));
          const boxKey = a.read(() => $box().getKey());
          const shared = () =>
            (
              a.binding as unknown as {state: {yByKey: Map<string, unknown>}}
            ).state.yByKey.get(boxKey);
          const before = shared();
          b.online = false;
          b.update(() => {
            ($box().getFirstChildOrThrow() as TextNode).spliceText(1, 0, 'R');
            $setSelection(null);
          });
          const $swap = () => {
            const p = $paragraph();
            const left = p.getFirstChildOrThrow();
            const right = p.getLastChildOrThrow();
            const box = $box();
            box.insertBefore(right);
            box.insertAfter(left);
          };
          if (path === 'read-edit') {
            a.update(() =>
              ($paragraph().getFirstChildOrThrow() as TextNode).select(1, 1),
            );
            reactions.set(a.editor, $swap);
            c.update(() => {
              const sep = (
                $getRoot().getLastChildOrThrow() as ElementNode
              ).getFirstChildOrThrow() as TextNode;
              sep.spliceText(9, 0, '!');
              $setSelection(null);
            });
          } else {
            a.update($swap);
          }
          await t.sync();
          expect(shared()).toBe(before);
          const fresh = await freshReader(a);
          onTestFinished(() => fresh.stop());
          const want =
            path === 'read-edit'
              ? 'right|aRbc|left|separator!'
              : 'right|aRbc|left|separator';
          for (const p of [...t.peers, fresh]) {
            expect(text(p)).toBe(want);
          }
        });
      }
    }
  }
});
