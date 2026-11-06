/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The recovery of a write that fails rewrites the same update, so it reads
// the update's record of merged nodes as the write did: a collaborator's
// character that the update merged into a neighbouring text node (Lexical's
// normalization after the hold that kept it showed it as a node of its own)
// is kept where it is stored, its item and all, not deleted and typed anew.

import type * as Y from '@y/y';

import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getEditor,
  $getRoot,
  $hasUpdateTag,
  $setCompositionKey,
  $setSelection,
  COLLABORATION_TAG,
  ElementNode,
  type LexicalEditor,
  TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

import {Writer} from '../../../internal/Write';
import {freshReader, NODES, type Peer, setup} from '../../utils/harness';

class MergeBox extends ElementNode {
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

/** A reaction an app runs once, from a selection transform in a read. */
const reactions = new WeakMap<LexicalEditor, () => void>();

class MergeHook extends TextNode {
  $config() {
    return this.config('merge_hook', {extends: TextNode});
  }
  // Merged with its neighbours like plain text (see TextNode#isSimpleText).
  isSimpleText() {
    return true;
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

/** The composed node (the first hook; new nodes are hooks too). */
let composedKey = '';
const $hook = () =>
  $getRoot()
    .getAllTextNodes()
    .find(n =>
      composedKey === '' ? n instanceof MergeHook : n.getKey() === composedKey,
    )!;

/** B's view of the composed text: its only hook. */
const $firstHook = () =>
  $getRoot()
    .getAllTextNodes()
    .find(n => n instanceof MergeHook)!;

/** A new bold node of its own (never merged), a hook as the composed one. */
const $newBold = (ch: string) =>
  $create(MergeHook).setTextContent(ch).setFormat(1).toggleUnmergeable();

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

/** One fault at the entry of A's `run`-th writer run from now on. */
function faultAt(doc: Y.Doc, run: number) {
  const original = Writer.prototype.$run;
  let runs = 0;
  let fired = false;
  Writer.prototype.$run = function (this: Writer) {
    if ((this as unknown as {tr: Y.Transaction}).tr.doc === doc) {
      runs++;
      if (!fired && runs === run) {
        fired = true;
        throw new Error('one-shot fault at a writer run entry');
      }
    }
    return original.call(this);
  };
  onTestFinished(() => {
    Writer.prototype.$run = original;
  });
  return () => fired;
}

async function start(gc: boolean, ids: number[], base: string, bold: boolean) {
  const t = await setup(
    () =>
      $getRoot().append(
        $createParagraphNode().append(
          $create(MergeBox).append(
            $create(MergeHook)
              .setTextContent(base)
              .setFormat(bold ? 1 : 0),
          ),
        ),
        $createParagraphNode().append($createTextNode('separator')),
      ),
    {gc, ids, nodes: [...NODES, MergeBox, MergeHook]},
  );
  onTestFinished(() => t.peers.forEach((p: Peer) => p.stop()));
  composedKey = '';
  t.a.update(() => {
    $hook().select(1, 1);
    $setCompositionKey($hook().getKey());
    composedKey = $hook().getKey();
  });
  await t.sync();
  return t;
}

async function end(t: Awaited<ReturnType<typeof start>>, held: string[]) {
  t.a.update(() => $setCompositionKey(null));
  await t.sync();
  const fresh = await freshReader(t.a);
  onTestFinished(() => fresh.stop());
  // Every peer shows what a fresh reader reads (the fault's recovered-write
  // warning is expected, see faultAt).
  const shown = (p: Peer) => p.read(() => $getRoot().getTextContent());
  for (const p of t.peers) {
    expect(shown(p)).toBe(shown(fresh));
  }
  for (const p of [...t.peers, fresh]) {
    // B's R, the very item, once, on every peer and a fresh reader.
    expect(liveIds(p.doc, 'R')).toEqual(held);
  }
}

describe('the recovery of a failed write keeps a held character the update merged into its neighbour', () => {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      const id = `gc ${gc ? 'on' : 'off'}, ids ${ids}`;

      // An app's edit in a remote change's read, with a write error: B
      // unbolds `abcabc` and types R in one update (held at A); an app
      // inserts new bold nodes in a read, the hold ends, and the write of
      // the update that merges B's R into its neighbour fails.
      test(`an app's edit in a read, then a fault when the hold ends (${id})`, async () => {
        const t = await start(gc, ids, 'abcabc', true);
        t.b.update(() => {
          $firstHook().setFormat(0);
          $firstHook().spliceText(6, 0, 'R');
          $setSelection(null);
        });
        await t.sync();
        // Held at A (before the hold of a change like this one, A showed
        // it, and this was never at risk: the expected outcome either way).
        const held = liveIds(t.b.doc, 'R');
        expect(held).toHaveLength(1);
        // A's second write from here: the update that ends the hold.
        const fired = faultAt(t.a.doc, 2);
        reactions.set(t.a.editor, () => {
          const before = $newBold('\ue000');
          $hook().insertBefore(before);
          before.select(1, 1);
          const [x] = $hook().splitText(1);
          const between = $newBold('\ue001');
          x.getLatest().insertAfter(between);
          between.select(1, 1);
        });
        t.c.update(() => {
          const separator = $getRoot()
            .getAllTextNodes()
            .find(n => n.getTextContent().startsWith('separator'))!;
          separator.spliceText(separator.getTextContentSize(), 0, '!');
          $setSelection(null);
        });
        await t.sync();
        expect(fired()).toBe(true);
        await end(t, held);
      });

      // A redo with a write error: B unbolds `aba` and types R in it (held
      // at A); A splits it around a new bold node, undoes that, and the
      // write of the redo, which merges B's R back into its neighbour, fails
      // (where a redo writes, see the undo manager's follow-up).
      test(`a redo that merges the held character back, then a fault (${id})`, async () => {
        const t = await start(gc, ids, 'aba', true);
        t.b.update(() => {
          $firstHook().setFormat(0);
          $firstHook().spliceText(1, 0, 'R');
          $setSelection(null);
        });
        await t.sync();
        const held = liveIds(t.b.doc, 'R');
        expect(held).toHaveLength(1);
        // A's second write from here: the redo's, where it writes (the undo
        // is read, and writes nothing).
        const fired = faultAt(t.a.doc, 2);
        t.a.update(() => {
          const [x] = $hook().splitText(1);
          const between = $newBold('\ue000');
          x.getLatest().insertAfter(between);
          between.select(1, 1);
        });
        await t.sync();
        t.a.binding.undo();
        await t.sync();
        t.a.binding.redo();
        await t.sync();
        expect(fired()).toBe(true);
        await end(t, held);
      });
    }
  }
});
