/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The copy repair (an undo's copy of an end gets content naming the copy of
// its opener) was installed by the first binding and removed with the last:
// an app UndoManager that redid into the document after its binding stopped
// sent unrepaired ends, and a reload or a peer read "Xb" plain where main
// keeps "b" bold (GPT code review r1, item 5). createYDoc now installs it
// before anything is applied, for the document's lifetime.

import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
} from 'lexical';
import {afterEach, expect, test} from 'vitest';

import {$selectIn, freshReader, setup} from '../../utils/harness';
import {
  setFormatIdentityWrites,
  setFormatIdentityWritesDefault,
} from '../../utils/noSwitch';

afterEach(() => {
  setFormatIdentityWritesDefault(false);
});

for (const gc of [false, true]) {
  test(`an app's redo after the binding stopped sends repaired ends (gc ${gc ? 'on' : 'off'})`, async () => {
    const t = await setup(
      () => {
        const text = $createTextNode('ab');
        text.toggleFormat('bold');
        $getRoot().append($createParagraphNode().append(text));
      },
      {gc},
    );
    const [a, b] = t.peers;
    setFormatIdentityWrites(a.doc, true);
    // The app's manager tracks the binding's writes; its undo keeps text
    // and deletes every format item (both members of each pair).
    const app = new Y.UndoManager(a.doc, {
      captureTimeout: 0,
      deleteFilter: item => item.content instanceof Y.ContentFormat,
      trackedOrigins: new Set<unknown>([a.binding]),
    });
    try {
      a.update(() => {
        const sel = $selectIn([0], 1, 1);
        sel.setFormat(0);
        sel.insertText('X');
        $setSelection(null);
      });
      await t.sync();
      app.undo();
      await t.sync();
      a.binding.dispose();
      app.redo();
      await t.sync();
      const reload = await freshReader(a);
      const runs = (
        reload.json().root.children[0] as unknown as {
          children: {text: string; format: number}[];
        }
      ).children.map(c => [c.text, c.format]);
      expect(runs).toEqual([
        ['a', 1],
        ['X', 0],
        ['b', 1],
      ]);
      expect(b.describe()).toBe(reload.describe());
    } finally {
      app.destroy();
    }
  });
}
