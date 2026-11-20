/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {$createParagraphNode, $createTextNode, $getRoot} from 'lexical';
import {describe, expect, test} from 'vitest';

// Regression test for https://github.com/meta/lexical/issues/8563
//
// Undo applies the previous editor state via `setEditorState`, which runs a
// FULL_RECONCILE without routing any structural change through
// `getWritable()`. That leaves `_cloneNotNeeded` empty, which the
// `sizeDelta === 0` children fast path used as its signal that the parent's
// children were structurally unchanged (same keys in the same order). When a
// child is replaced by a different-key child of equal count (e.g. undo turning
// a code block back into the paragraphs it was made from), the fast path
// walked from `prevElement.__first` while following the *next* map's `__next`
// pointers and reached a key that only exists in the next state, throwing
// `reconcileNode: prevNode or nextNode does not exist in nodeMap`.
describe('Issue #8563: full reconcile with same-size child key swap', () => {
  test('undo (setEditorState) does not crash when a child is replaced by a different-key child of equal count', () => {
    const errors: Error[] = [];
    using editor = buildEditorFromExtensions({
      dependencies: [RichTextExtension],
      name: 'issue-8563-repro',
      onError: e => {
        errors.push(e);
      },
    });
    // A root element makes DOM reconciliation run; the crash is in node-map
    // lookups so the element does not need to be attached to the document.
    // `using` disposal calls setRootElement(null).
    editor.setRootElement(document.createElement('div'));

    // State A: enough children to engage the fast path (>= 4).
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        for (let i = 0; i < 5; i++) {
          root.append(
            $createParagraphNode().append($createTextNode(`line ${i}`)),
          );
        }
      },
      {discrete: true},
    );
    const stateA = editor.getEditorState();

    // State B: replace only the last child, keeping the count at 5 and the
    // first child key unchanged. This is the shape an undo of a block
    // transform produces (a same-size child swap at the end of root).
    editor.update(
      () => {
        $getRoot()
          .getLastChildOrThrow()
          .replace($createParagraphNode().append($createTextNode('replaced')));
      },
      {discrete: true},
    );

    // Undo: restore state A. FULL_RECONCILE from B with a same-size,
    // different-last-key children list — used to crash reconciliation.
    editor.setEditorState(stateA);

    expect(errors).toEqual([]);
    expect(editor.read(() => $getRoot().getTextContent())).toBe(
      'line 0\n\nline 1\n\nline 2\n\nline 3\n\nline 4',
    );
    expect(editor.getRootElement()!.textContent).toBe(
      'line 0line 1line 2line 3line 4',
    );
  });
});
