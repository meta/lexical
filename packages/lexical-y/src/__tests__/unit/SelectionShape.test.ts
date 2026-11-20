/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// The selection the binding restores after a remote change keeps the shape
// of the user's selection: a caret is never widened into a range the user
// did not make (a Backspace would delete it).

import * as Y from '@y/y';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {$p, expectConverged, setup} from '../utils/harness';

test('a caret the user collapsed right before a remote change stays a caret', async () => {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    const t = await setup(
      () => $getRoot().append($p('alpha beta gamma'), $p('delta')),
      {ids},
    );
    t.offline();
    t.b.update(() => {
      ($getRoot().getLastChildOrThrow() as ElementNode).selectEnd();
      $getSelection()!.insertText(' epsilon');
    });
    // A selects "beta", then collapses the selection with an update that
    // waits for a microtask (as an arrow key does).
    t.a.update(() => {
      const text = (
        $getRoot().getFirstChildOrThrow() as ElementNode
      ).getFirstChildOrThrow() as TextNode;
      text.select(6, 10);
    });
    t.a.editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        const {key, offset, type} = selection.focus;
        selection.anchor.set(key, offset, type);
      }
    });
    // B's change reaches A in the same task, before that update commits.
    Y.applyUpdate(
      t.a.doc,
      Y.encodeStateAsUpdate(t.b.doc, Y.encodeStateVector(t.a.doc)),
      t.a.net,
    );
    const shape = t.a.read(() => {
      const selection = $getSelection();
      return $isRangeSelection(selection)
        ? {
            collapsed: selection.isCollapsed(),
            offset: selection.anchor.offset,
          }
        : null;
    });
    expect(shape).toEqual({collapsed: true, offset: 10});
    await t.sync();
    await expectConverged(t.peers);
  }
});
