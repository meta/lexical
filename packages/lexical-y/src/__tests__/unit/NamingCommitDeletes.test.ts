/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// An app's update queued from an update listener is merged by Lexical into
// the next commit: here BlockIdExtension's naming commit (after an update
// that skipped transforms), which the binding writes as a follow-up. Its
// deletion of a block node and the line after it, inside a stored format
// run that crosses them (see DeletedBlockFormats), deleted the opener the
// line after them relied on: the author kept the format, every reader lost
// it (R12B-C1).

import '../utils/blockIdsEnv';

import {
  $getRoot,
  $isElementNode,
  $isTextNode,
  type ElementNode,
  type LexicalNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {
  $p,
  expectConverged,
  freshReader,
  type Peer,
  setup,
  WidgetNode,
  WITH_BLOCK_IDS,
} from '../utils/harness';

delete process.env.LEXICAL_Y_BLOCK_ID;

/** Every block's text runs, bold ones in brackets. */
function runs(peer: Peer): string[] {
  return peer.read(() =>
    $getRoot()
      .getChildren()
      .map((block: LexicalNode) =>
        $isElementNode(block)
          ? (block as ElementNode)
              .getChildren()
              .filter($isTextNode)
              .map(t =>
                t.hasFormat('bold')
                  ? `[${t.getTextContent()}]`
                  : t.getTextContent(),
              )
              .join('')
          : block.getType(),
      ),
  );
}

test('the tests build their editors with BlockIdExtension', () => {
  expect(WITH_BLOCK_IDS).toBe(true);
});

for (const skipTransforms of [false, true]) {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`an app's deletion merged into the commit after a new paragraph${skipTransforms ? ' (transforms skipped: the naming commit)' : ''} keeps the format after it (ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $p('A'),
            new WidgetNode(),
            $p('Rehabix'),
            $p('Rebifex'),
            $p('end'),
          ),
        {ids},
      );
      // Bold opened before the widget and closed after it, and opened again
      // before "Rehabix"'s marker, running over "Rebifex".
      const root = t.a.doc.get('lexical-y');
      t.a.doc.transact(() => {
        root.format(2, 1, {'f:bold': true});
        root.format(10, 8, {'f:bold': true});
      }, 'outside');
      await t.sync();
      expect(runs(t.a)).toEqual([
        'A',
        'test_widget',
        'Rehabix',
        '[Rebifex]',
        'end',
      ]);
      const tags: string[][] = [];
      let queued = false;
      const stop = t.a.editor.registerUpdateListener(update => {
        tags.push([...update.tags]);
        if (update.tags.has('app-trigger') && !queued) {
          queued = true;
          t.a.editor.update(() => {
            $getRoot().getChildAtIndex(1)!.remove();
            $getRoot().getChildAtIndex(1)!.remove();
          });
        }
      });
      t.a.editor.update(() => $getRoot().append($p('new')), {
        discrete: true,
        tag: 'app-trigger',
        ...(skipTransforms ? {skipTransforms: true} : {}),
      });
      await t.sync();
      stop();
      expect(queued).toBe(true);
      if (skipTransforms) {
        expect(tags.some(list => list.includes('block-id-repair'))).toBe(true);
      }
      const after = ['A', '[Rebifex]', 'end', 'new'];
      expect(runs(t.a)).toEqual(after);
      // The other client and a fresh reader showed "Rebifex" plain here.
      expect(runs(t.b)).toEqual(after);
      expect(runs(await freshReader(t.a))).toEqual(after);
      await expectConverged(t.peers);
    });
  }
}
