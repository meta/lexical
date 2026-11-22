/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// The client that formats a link whose text sits in a mark, then deletes
// that text itself (keeping a line break): the link holds no text, so
// Lexical serializes its textFormat, which was set while the link held text
// and is stored nowhere. The link shows the stored value in that same
// update, so no commit of the binding follows for an app to answer: an
// update listener that answers collaboration-tagged commits (with a change
// of the link's attributes, or with a change the binding does not write)
// never runs. Text fields the same update sets on the link are its own, and
// are stored.

import {$createLinkNode} from '@lexical/link';
import {$createMarkNode} from '@lexical/mark';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
  COLLABORATION_TAG,
  type ElementNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {
  $selectIn,
  expectConverged,
  flush,
  freshReader,
  setup,
} from '../../utils/harness';

const $link = () =>
  ($getRoot().getFirstChildOrThrow() as ElementNode)
    .getChildren()
    .find(n => n.getType() === 'link') as ElementNode;

for (const reply of ['none', 'attrs', 'refused'] as const) {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`own delete leaves the link with its stored fields, reply ${reply}, ids ${ids}`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('before '),
              $createLinkNode('https://example.test').append(
                $createMarkNode(['comment']).append(
                  $createTextNode('word'),
                  $createLineBreakNode(),
                ),
              ),
              $createTextNode(' after'),
            ),
          );
        },
        {ids},
      );
      try {
        t.b.update(() => {
          $selectIn([0], 0, 11).formatText('bold');
          $setSelection(null);
        });
        await t.sync();
        const undoStack = t.b.binding.undoManager!.undoStack;
        const before = undoStack.length;
        let tagged = 0;
        let replies = 0;
        const stop = t.b.editor.registerUpdateListener(({tags}) => {
          if (!tags.has(COLLABORATION_TAG)) {
            return;
          }
          tagged++;
          if (reply === 'none' || replies >= 12) {
            return;
          }
          replies++;
          t.b.editor.update(
            () => {
              if (reply === 'attrs') {
                $link().setTextStyle('color: red');
              } else {
                $getRoot().append(
                  $createParagraphNode().append($createTextNode('reply')),
                );
              }
            },
            {discrete: true, tag: 'block-id-repair'},
          );
        });
        t.b.update(() => {
          for (const text of $getRoot().getAllTextNodes()) {
            if (text.getTextContent() === 'word') {
              text.remove();
            }
          }
          $setSelection(null);
        });
        await t.sync();
        for (let i = 0; i < 3; i++) {
          await flush();
        }
        stop();
        expect(tagged, 'no commit of the binding follows').toBe(0);
        expect(undoStack.length, 'one undo step').toBe(before + 1);
        expect(t.b.read(() => $link().getTextFormat())).toBe(0);
        const fresh = await freshReader(t.b);
        expect(t.b.json()).toEqual(fresh.json());
        await expectConverged(t.peers);
      } finally {
        for (const p of t.peers) {
          p.stop();
        }
      }
    });
  }
}

for (const format of [0, 2, 16]) {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`text fields set in the update that leaves the link without text are stored, format ${format}, ids ${ids}`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('before '),
              $createLinkNode('https://example.test').append(
                $createMarkNode(['comment']).append(
                  $createTextNode('word'),
                  $createLineBreakNode(),
                ),
              ),
              $createTextNode(' after'),
            ),
          );
        },
        {ids},
      );
      try {
        t.b.update(() => {
          $selectIn([0], 0, 11).formatText('bold');
          $setSelection(null);
        });
        await t.sync();
        t.b.update(() => {
          for (const text of $link().getAllTextNodes()) {
            text.remove();
          }
          $link().setTextFormat(format).setTextStyle('color: red');
          $setSelection(null);
        });
        await t.sync();
        const $fields = () => ({
          format: $link().getTextFormat(),
          style: $link().getTextStyle(),
        });
        expect(t.b.read($fields)).toEqual({format, style: 'color: red'});
        const fresh = await freshReader(t.b);
        expect(fresh.read($fields)).toEqual({format, style: 'color: red'});
        await expectConverged(t.peers);
      } finally {
        for (const p of t.peers) {
          p.stop();
        }
      }
    });
  }
}
