/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A bolds `abc` in `xxabcyy` and undoes it; B types X right after `c` or
// right before `a`; A redoes. Text typed right after the format's edge stays
// outside it once the format is redone, and text typed right before it joins
// it: the reverse of the leftmost rule of Word, Google Docs, Pages,
// ProseMirror and Yjs, an accepted limit (DECISIONS.md D105). Typed text
// steps past the format items the undo deleted, as Yjs does, and the redo
// puts its restored opener and end directly before them. The same in both
// client id orders, gc off and on, and where B types while A redoes; every
// peer and a fresh reader.

import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isTextNode,
  $setSelection,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {expect, onTestFinished, test} from 'vitest';

import {
  expectConverged,
  freshReader,
  type Peer,
  setup,
} from '../../utils/harness';

const $line = (): ElementNode =>
  $getRoot().getFirstChildOrThrow() as ElementNode;

function $textAt(offset: number): [TextNode, number] {
  let acc = 0;
  const texts = $line().getChildren().filter($isTextNode);
  for (const text of texts) {
    const size = text.getTextContentSize();
    if (offset <= acc + size) {
      return [text, offset - acc];
    }
    acc += size;
  }
  const last = texts[texts.length - 1];
  return [last, last.getTextContentSize()];
}

function $typeAt(offset: number, text: string): void {
  const [node, at] = $textAt(offset);
  const selection = $createRangeSelection();
  selection.anchor.set(node.getKey(), at, 'text');
  selection.focus.set(node.getKey(), at, 'text');
  $setSelection(selection);
  selection.format = 0;
  selection.insertText(text);
  $setSelection(null);
}

function bolds(peer: Peer): string {
  return peer.read(() =>
    $line()
      .getChildren()
      .filter($isTextNode)
      .map(text =>
        [...text.getTextContent()]
          .map(c => (text.hasFormat('bold') ? c.toUpperCase() : c))
          .join(''),
      )
      .join(''),
  );
}

for (const concurrent of [false, true]) {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      for (const edge of ['after', 'before'] as const) {
        test(`X typed right ${edge} a bold that was undone ${edge === 'after' ? 'stays outside it' : 'joins it'} once it is redone${concurrent ? ', typed while it is redone' : ''} (gc ${gc ? 'on' : 'off'}, ids ${ids.join('/')})`, async () => {
          const t = await setup(
            () =>
              $getRoot().append(
                $createParagraphNode().append($createTextNode('xxabcyy')),
              ),
            {gc, ids},
          );
          onTestFinished(() => t.peers.forEach(p => p.stop()));
          t.a.update(() => {
            const [middle] = $textAt(0)[0].splitText(2, 5).slice(1);
            middle.toggleFormat('bold');
            $setSelection(null);
          });
          await t.sync();
          t.a.undo();
          await t.sync();
          expect(bolds(t.b)).toBe('xxabcyy');
          if (concurrent) {
            t.offline();
          }
          t.b.update(() => $typeAt(edge === 'after' ? 5 : 2, 'x'));
          if (!concurrent) {
            await t.sync();
          }
          t.a.binding.undoManager!.stopCapturing();
          t.a.binding.redo();
          await t.sync();
          await t.sync();
          await expectConverged(t.peers);
          const fresh = await freshReader(t.a);
          onTestFinished(() => fresh.stop());
          for (const peer of [...t.peers, fresh]) {
            expect(bolds(peer)).toBe(
              edge === 'after' ? 'xxABCxyy' : 'xxXABCyy',
            );
          }
        });
      }
    }
  }
}
