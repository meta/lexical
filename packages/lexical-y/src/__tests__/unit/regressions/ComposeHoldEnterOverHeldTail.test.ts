/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A composition ended with Enter in a line where a collaborator's insertion
// is held back (the hold keeps it from the editor): the line splits, and the
// text after the split point moves to the new line. A held item in that tail
// is never deleted: no write deletes what a composition holds back, so the
// held character survives exactly once, every peer agrees, and the editor
// shows what is stored once the hold ends.

import {
  $create,
  $getEditor,
  $getRoot,
  $getSelection,
  $hasUpdateTag,
  $isRangeSelection,
  $isTextNode,
  $setCompositionKey,
  $setSelection,
  COLLABORATION_TAG,
  type LexicalEditor,
  ParagraphNode,
  TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test, vi} from 'vitest';

import {createYDoc} from '../../..';
import {
  deleteItemIn,
  HeldDeletionError,
  withProtected,
} from '../../../internal/Seen';
import {
  expectConverged,
  freshReader,
  NODES,
  type Peer,
  setup,
} from '../../utils/harness';

/** A reaction an app runs once, from a selection transform in a read. */
const reactions = new WeakMap<LexicalEditor, () => void>();

/** Composed text whose selection transform runs an app's reaction. */
class EnterHook extends TextNode {
  $config() {
    return this.config('enter_hook', {extends: TextNode});
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

const $composed = () => $getRoot().getAllTextNodes()[0];

const text = (p: Peer) =>
  p.read(() =>
    $getRoot()
      .getChildren()
      .map(n => n.getTextContent())
      .join('|'),
  );

describe('a composition ended with Enter over a held insertion', () => {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      for (const where of [
        'in the moved tail',
        'at the split point, before the composed text',
        'before the split point',
      ]) {
        for (const mode of ['local', 'in a remote read']) {
          test(`${where}, ${mode} (gc ${gc}, ids ${ids.join(',')}): the held character is kept once, and every peer agrees`, async () => {
            const t = await setup(
              () =>
                $getRoot().append(
                  $create(ParagraphNode).append(
                    $create(EnterHook).setTextContent('abcdef'),
                  ),
                  $create(ParagraphNode).append(
                    $create(TextNode).setTextContent('other'),
                  ),
                ),
              {gc, ids, nodes: [...NODES, EnterHook]},
            );
            const errors = vi
              .spyOn(console, 'error')
              .mockImplementation(() => {});
            onTestFinished(() => errors.mockRestore());
            const {a, b, c} = t;
            a.update(() => {
              $composed().select(3, 3);
              $setCompositionKey($composed().getKey());
            });
            await t.sync();
            // A collaborator's insertion in the line composed in: held at A.
            b.update(() => {
              $composed().spliceText(
                where === 'in the moved tail' ? 4 : 1,
                0,
                'R',
              );
              $setSelection(null);
            });
            await t.sync();
            expect(a.read(() => $composed().getTextContent())).toBe('abcdef');
            // A types its composed text at its caret.
            a.update(() => {
              $composed().spliceText(3, 0, 'X');
              $composed().select(4, 4);
            });
            await t.sync();
            // The composition ends with Enter at its caret (after `abc`).
            const $enter = () => {
              const node = $getRoot()
                .getAllTextNodes()
                .find(n => n.getTextContent() === 'abcXdef')!;
              // In front of the composed text, as an IME's Enter can.
              node.select(3, 3);
              const selection = $getSelection();
              if ($isRangeSelection(selection)) {
                selection.insertParagraph();
              }
            };
            if (mode === 'local') {
              a.update($enter);
            } else {
              reactions.set(a.editor, $enter);
              c.update(() => {
                const other = $getRoot()
                  .getAllTextNodes()
                  .find(n => n.getTextContent() === 'other')!;
                other.spliceText(5, 0, '!');
                $setSelection(null);
              });
            }
            await t.sync();
            a.update(() => {
              $setCompositionKey(null);
              $setSelection(null);
            });
            await t.sync();
            const fresh = await freshReader(a);
            onTestFinished(() => fresh.stop());
            const stored = text(fresh);
            for (const p of [...t.peers, fresh]) {
              expect(text(p).split('R')).toHaveLength(2);
            }
            expect(text(a)).toBe(stored);
            expect(
              a
                .read(() =>
                  $getRoot()
                    .getAllTextNodes()
                    .filter($isTextNode)
                    .map(n => n.getTextContent())
                    .join(''),
                )
                .replace('R', ''),
            ).toContain('abcdef'.slice(0, 3));
            expect(
              errors.mock.calls.some(call =>
                String(call[0]).includes('did not foresee'),
              ),
            ).toBe(false);
            await expectConverged(t.peers);
          });
        }
      }
    }
  }
});

// The guard behind the hold check: a write never deletes an item the hold
// keeps back, whichever path reaches it (a soak found an Enter that split the
// line in front of a collaborator's held text and rewrote the tail). Stopped
// where the write inserts no character, left in place where it inserts some
// (reported), and left in place in a recovery's skip mode.
describe('a held text item is never deleted by a write', () => {
  for (const mode of [false, true, 'skip'] as const) {
    test(`mode ${String(mode)}`, () => {
      const doc = createYDoc(null, {gc: false});
      const root = doc.get('lexical-y');
      root.insert(0, 'abc');
      const item = root._start!;
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      onTestFinished(() => errors.mockRestore());
      let thrown: unknown = null;
      doc.transact(tr => {
        try {
          withProtected(
            null,
            mode,
            () => deleteItemIn(null, item, tr),
            it => it === item,
          );
        } catch (e) {
          thrown = e;
        }
      });
      expect(item.deleted).toBe(false);
      expect(thrown instanceof HeldDeletionError).toBe(mode === false);
      expect(errors.mock.calls.length > 0).toBe(mode === true);
    });
  }
});
