/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// An app's edit in a remote change's read is written with the update's own
// record of what it moved (keyed by the state the update started from), as
// a local update is: a move rewrites the line it moved, not the lines it
// passed, so a collaborator's characters in a line it passed keep their
// items.

import type * as Y from '@y/y';

import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getEditor,
  $getRoot,
  $hasUpdateTag,
  $setSelection,
  COLLABORATION_TAG,
  type LexicalEditor,
  type ParagraphNode,
  TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

import {freshReader, NODES, type Peer, setup} from '../../utils/harness';

/** A reaction an app runs once, from a selection transform in a read. */
const reactions = new WeakMap<LexicalEditor, () => void>();

class MoveHook extends TextNode {
  $config() {
    return this.config('move_hook', {extends: TextNode});
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

/** The ids of the live items holding `ch`, one per character. */
const liveIds = (doc: Y.Doc, ch: string): string[] => {
  const out: string[] = [];
  for (const [client, structs] of doc.store.clients) {
    for (const s of structs) {
      const str = (s as {content?: {str?: string}}).content?.str;
      if (str === undefined || (s as {deleted: boolean}).deleted) {
        continue;
      }
      for (let i = 0; i < str.length; i++) {
        if (str[i] === ch) {
          out.push(`${client}:${s.id.clock + i}`);
        }
      }
    }
  }
  return out.sort();
};

const lines = (p: Peer) =>
  p.read(() =>
    $getRoot()
      .getChildren()
      .map(n => n.getTextContent()),
  );

const $line = (text: string) =>
  $getRoot()
    .getChildren()
    .find(n => n.getTextContent().startsWith(text)) as ParagraphNode;

describe("an app's move in a remote change's read keeps a collaborator's characters in the lines it passed", () => {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      test(`the longer line moved past the line B typed in (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append(
                $create(MoveHook).setTextContent('hook'),
              ),
              $createParagraphNode().append(
                $createTextNode('a much longer line here'),
              ),
              $createParagraphNode().append($createTextNode('b')),
              $createParagraphNode().append($createTextNode('separator')),
            ),
          {gc, ids, nodes: [...NODES, MoveHook]},
        );
        onTestFinished(() => t.peers.forEach((p: Peer) => p.stop()));
        t.b.update(() => {
          const b = $line('b').getFirstChildOrThrow() as TextNode;
          b.spliceText(1, 0, 'X');
          $setSelection(null);
        });
        await t.sync();
        const typed = liveIds(t.b.doc, 'X');
        expect(typed).toHaveLength(1);
        // A's selection on the hook, whose selection transform runs the app's
        // reaction in A's next read.
        t.a.update(() => {
          (
            (
              $getRoot().getFirstChildOrThrow() as ParagraphNode
            ).getFirstChildOrThrow() as TextNode
          ).select(1, 1);
        });
        await t.sync();
        reactions.set(t.a.editor, () => {
          $line('bX').insertAfter($line('a much longer'));
        });
        t.c.update(() => {
          const separator = $line(
            'separator',
          ).getFirstChildOrThrow() as TextNode;
          separator.spliceText(separator.getTextContentSize(), 0, '!');
          $setSelection(null);
        });
        await t.sync();
        const fresh = await freshReader(t.a);
        onTestFinished(() => fresh.stop());
        for (const p of [...t.peers, fresh]) {
          expect(lines(p)).toEqual([
            'hook',
            'bX',
            'a much longer line here',
            'separator!',
          ]);
          // B's X, the very item, once.
          expect(liveIds(p.doc, 'X')).toEqual(typed);
        }
      });
    }
  }
});
