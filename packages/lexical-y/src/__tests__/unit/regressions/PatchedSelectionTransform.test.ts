/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// An app that patches TextNode's own selectionTransform (every text class
// then runs it) and edits in it while a remote change is read: the edit is
// written as one in a text class's own selectionTransform is (D111). The
// binding took TextNode's selectionTransform, patched, for the one that does
// nothing, kept no copies of the read, and wrote nothing: the edit showed on
// this client only until the next read put the document back.

import {$createCodeNode} from '@lexical/code';
import {registerCodeHighlighting} from '@lexical/code-prism';
import {
  $createParagraphNode,
  $createTextNode,
  $getEditor,
  $getRoot,
  $hasUpdateTag,
  $setSelection,
  type BaseSelection,
  COLLABORATION_TAG,
  type LexicalEditor,
  type RangeSelection,
  TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

import {doesNothing} from '../../../internal/Binding';
import {expectConverged, freshReader, setup} from '../../utils/harness';

/** Patch TextNode's own selectionTransform to run `reaction` once on `editor`. */
function patchOnce(editor: LexicalEditor, reaction: () => void) {
  const original = TextNode.prototype.selectionTransform;
  let ran = false;
  function $patched(
    this: TextNode,
    prevSelection: BaseSelection | null,
    nextSelection: RangeSelection,
  ): void {
    if (!ran && $getEditor() === editor && $hasUpdateTag(COLLABORATION_TAG)) {
      ran = true;
      reaction();
    }
    original.call(this, prevSelection, nextSelection);
  }
  TextNode.prototype.selectionTransform = $patched;
  onTestFinished(() => {
    TextNode.prototype.selectionTransform = original;
  });
}

describe('an edit in a patched TextNode selectionTransform, in a remote read', () => {
  for (const gc of [false, true]) {
    for (const code of [false, true]) {
      test(`${code ? 'a highlighted code line' : 'a paragraph'} (gc ${gc})`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              code
                ? $createCodeNode('javascript').append($createTextNode('abc'))
                : $createParagraphNode().append($createTextNode('abc')),
              $createParagraphNode().append($createTextNode('other')),
            ),
          {
            gc,
            ids: [1, 2, 3],
            prepare: code
              ? editor => onTestFinished(registerCodeHighlighting(editor))
              : undefined,
          },
        );
        const {a, c} = t;
        a.update(() => {
          $getRoot().getAllTextNodes()[0].select(3, 3);
        });
        await t.sync();
        patchOnce(a.editor, () => {
          const text = $getRoot().getAllTextNodes()[0];
          text.spliceText(3, 0, 'X');
          text.select(4, 4);
        });
        c.update(() => {
          $getRoot()
            .getAllTextNodes()
            .find(n => n.getTextContent() === 'other')!
            .spliceText(5, 0, '!');
          $setSelection(null);
        });
        await t.sync();
        for (const p of t.peers) {
          const text = p.read(() => $getRoot().getTextContent());
          expect(text).toContain('abcX');
          expect(text).toContain('other!');
        }
        expect(a.describe()).toBe((await freshReader(a)).describe());
        await expectConverged(t.peers);
      });
    }
  }
});

// TextNode's untouched selectionTransform does nothing, so a read with the
// caret in text keeps no copies (and holds no notification) in an editor no
// app patched; a method that runs code does not.
test("TextNode's own selectionTransform counts as doing nothing", () => {
  expect(doesNothing(TextNode.prototype.selectionTransform)).toBe(true);
  expect(
    doesNothing(function selectionTransform(a: unknown, b: unknown) {}),
  ).toBe(true);
  expect(doesNothing(function (a: unknown, b = String(a)) {})).toBe(false);
  expect(
    doesNothing(function (a: unknown) {
      String(a);
    }),
  ).toBe(false);
});
